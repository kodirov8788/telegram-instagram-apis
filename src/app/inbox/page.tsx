'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Inbox as InboxIcon,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  User,
} from 'lucide-react';
import { AppShell, EmptyState, ErrorState, Skeleton, SkeletonList } from '@/components/shell';
import { Badge, Button, Input, type BadgeTone } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace/context';

// ---------------------------------------------------------------------------
// Types — mirror the shapes returned by /api/conversations, /api/conversations/:id
// and /api/messages (see route files for the exact SQL projections).
// ---------------------------------------------------------------------------

type ChannelType = 'telegram' | 'instagram';
type ControlMode = 'auto' | 'approval' | 'suggestion' | 'human';
type ConversationStatus =
  | 'new'
  | 'ai_handling'
  | 'waiting_for_customer'
  | 'human_attention_required'
  | 'human_handling'
  | 'qualified_lead'
  | 'resolved'
  | 'closed'
  | 'spam';

interface ConversationListItem {
  id: string;
  workspace_id: string;
  customer_id: string;
  channel: ChannelType;
  status: ConversationStatus;
  mode: ControlMode;
  full_name: string | null;
  telegram_username: string | null;
  instagram_username: string | null;
  unread_count: number;
  last_message: string | null;
  last_message_at: string;
}

interface ConversationDetail extends ConversationListItem {
  phone_number: string | null;
  email: string | null;
  detected_language: string | null;
  detected_intent: string | null;
  sentiment: string | null;
  lead_score: number | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender: 'customer' | 'ai' | 'human_operator' | 'system';
  sender_user_id: string | null;
  content: string;
  message_type: string;
  attachment_url: string | null;
  delivery_status: string;
  ai_confidence: number | null;
  created_at: string;
}

interface LeadRow {
  id: string;
  conversation_id: string | null;
  status: string;
}

const CHANNEL_TONE: Record<ChannelType, BadgeTone> = {
  telegram: 'brand',
  instagram: 'instagram',
};

const MODE_TONE: Record<ControlMode, BadgeTone> = {
  auto: 'success',
  approval: 'warning',
  suggestion: 'secondary',
  human: 'error',
};

const MODE_LABEL: Record<ControlMode, string> = {
  auto: 'AI Auto',
  approval: 'Approval',
  suggestion: 'Suggestion',
  human: 'Human',
};

const STATUS_LABEL: Record<ConversationStatus, string> = {
  new: 'New',
  ai_handling: 'AI Handling',
  waiting_for_customer: 'Waiting on Customer',
  human_attention_required: 'Needs Attention',
  human_handling: 'Human Handling',
  qualified_lead: 'Qualified Lead',
  resolved: 'Resolved',
  closed: 'Closed',
  spam: 'Spam',
};

async function readJson(res: Response) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export default function InboxPage() {
  // `useWorkspace()` must be called from a DESCENDANT of the
  // `WorkspaceProvider` that `AppShell` mounts — InboxPage itself renders
  // `AppShell`, so it sits above the provider in the tree and can't call
  // the hook directly. `InboxPageInner` is rendered as AppShell's child so
  // the hook resolves correctly.
  return (
    <AppShell className="p-0 sm:p-0">
      <InboxPageInner />
    </AppShell>
  );
}

function InboxPageInner() {
  const { apiFetch, activeWorkspace, loading: workspaceLoading, error: workspaceError } = useWorkspace();

  // Conversation list state
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Filters (client-side, per issue scope)
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ConversationStatus>('all');
  const [channelFilter, setChannelFilter] = useState<'all' | ChannelType>('all');

  // Selected conversation / thread state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<MessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  // Composer state
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Mode toggle state
  const [modeUpdating, setModeUpdating] = useState(false);

  // Approve/reject state
  const [actingMessageId, setActingMessageId] = useState<string | null>(null);

  // Lead context
  const [lead, setLead] = useState<LeadRow | null>(null);

  const fetchConversations = useCallback(async () => {
    if (!activeWorkspace) return;
    setListLoading(true);
    setListError(null);
    try {
      const res = await apiFetch('/api/conversations');
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || `Failed to load conversations (${res.status})`);
      setConversations(body.conversations ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load conversations.');
    } finally {
      setListLoading(false);
    }
  }, [apiFetch, activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace) fetchConversations();
  }, [fetchConversations, activeWorkspace]);

  const fetchThread = useCallback(async (conversationId: string) => {
    if (!activeWorkspace) return;
    setThreadLoading(true);
    setThreadError(null);
    try {
      const [convRes, draftsRes] = await Promise.all([
        apiFetch(`/api/conversations/${conversationId}`),
        apiFetch(`/api/messages?conversationId=${conversationId}`),
      ]);
      const convBody = await readJson(convRes);
      if (!convRes.ok) throw new Error(convBody?.error || `Failed to load conversation (${convRes.status})`);
      const draftsBody = await readJson(draftsRes);
      if (!draftsRes.ok) throw new Error(draftsBody?.error || `Failed to load drafts (${draftsRes.status})`);

      setDetail(convBody.conversation);
      setMessages(convBody.messages ?? []);
      setPendingDrafts(draftsBody.messages ?? []);
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to load conversation.');
      setDetail(null);
      setMessages([]);
      setPendingDrafts([]);
    } finally {
      setThreadLoading(false);
    }
  }, [apiFetch, activeWorkspace]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setPendingDrafts([]);
      setLead(null);
      return;
    }
    if (activeWorkspace) fetchThread(selectedId);
  }, [selectedId, fetchThread, activeWorkspace]);

  // Best-effort linked-lead lookup: /api/leads has no conversation_id filter
  // param, so fetch the workspace's leads and match client-side. Falls back
  // silently (context panel just omits the lead link) if this fails.
  useEffect(() => {
    if (!selectedId || !activeWorkspace) return;
    let cancelled = false;
    apiFetch('/api/leads')
      .then(readJson)
      .then((body) => {
        if (cancelled) return;
        const match = (body.leads ?? []).find((l: LeadRow) => l.conversation_id === selectedId);
        setLead(match ?? null);
      })
      .catch(() => {
        if (!cancelled) setLead(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, apiFetch, activeWorkspace]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (channelFilter !== 'all' && c.channel !== channelFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = `${c.full_name ?? ''} ${c.telegram_username ?? ''} ${c.instagram_username ?? ''} ${c.last_message ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, statusFilter, channelFilter, search]);

  const handleSelectConversation = (id: string) => {
    setSelectedId(id);
    setReplyText('');
    setSendError(null);
  };

  const handleModeChange = async (mode: ControlMode) => {
    if (!detail || modeUpdating) return;
    setModeUpdating(true);
    try {
      const res = await apiFetch('/api/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: detail.id, mode }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || `Failed to update mode (${res.status})`);
      setDetail((prev) => (prev ? { ...prev, mode: body.conversation.mode, status: body.conversation.status } : prev));
      setConversations((prev) =>
        prev.map((c) => (c.id === detail.id ? { ...c, mode: body.conversation.mode, status: body.conversation.status } : c))
      );
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to update mode.');
    } finally {
      setModeUpdating(false);
    }
  };

  const handleSendReply = async () => {
    if (!detail || !replyText.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await apiFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: detail.id, content: replyText.trim() }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || `Failed to send message (${res.status})`);
      setReplyText('');
      await fetchThread(detail.id);
      await fetchConversations();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  const handleApprove = async (messageId: string) => {
    if (actingMessageId) return;
    setActingMessageId(messageId);
    try {
      const res = await apiFetch(`/api/messages/${messageId}/approve`, {
        method: 'POST',
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || `Failed to approve (${res.status})`);
      if (detail) await fetchThread(detail.id);
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to approve message.');
    } finally {
      setActingMessageId(null);
    }
  };

  const handleReject = async (messageId: string) => {
    if (actingMessageId) return;
    setActingMessageId(messageId);
    try {
      const res = await apiFetch(`/api/messages/${messageId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || `Failed to reject (${res.status})`);
      if (detail) await fetchThread(detail.id);
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Failed to reject message.');
    } finally {
      setActingMessageId(null);
    }
  };

  // Workspace discovery still in flight — the shared context, not this
  // page, owns that loading state.
  if (workspaceLoading) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (workspaceError) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center p-6">
        <ErrorState title="Couldn't load your workspace" message={workspaceError} />
      </div>
    );
  }

  // No workspace selected yet — either the user has none (onboarding
  // territory, handled by middleware redirect before this page can even
  // render) or has multiple with none chosen (workspace-switcher UI is a
  // separate future concern, not this page's job to build).
  if (!activeWorkspace) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center p-6">
        <EmptyState
          icon={InboxIcon}
          title="No workspace selected"
          message="Select a workspace to view its inbox."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <ConversationListPanel
        conversations={filteredConversations}
        loading={listLoading}
        error={listError}
        onRetry={fetchConversations}
        onRefresh={fetchConversations}
        selectedId={selectedId}
        onSelect={handleSelectConversation}
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        channelFilter={channelFilter}
        onChannelFilterChange={setChannelFilter}
      />

      <ThreadPanel
        selectedId={selectedId}
        detail={detail}
        messages={messages}
        pendingDrafts={pendingDrafts}
        loading={threadLoading}
        error={threadError}
        onRetry={() => selectedId && fetchThread(selectedId)}
        onModeChange={handleModeChange}
        modeUpdating={modeUpdating}
        replyText={replyText}
        onReplyTextChange={setReplyText}
        onSendReply={handleSendReply}
        sending={sending}
        sendError={sendError}
        onApprove={handleApprove}
        onReject={handleReject}
        actingMessageId={actingMessageId}
      />

      <ContextPanel detail={detail} lead={lead} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left column — conversation list
// ---------------------------------------------------------------------------

function ConversationListPanel(props: {
  conversations: ConversationListItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onRefresh: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: 'all' | ConversationStatus;
  onStatusFilterChange: (v: 'all' | ConversationStatus) => void;
  channelFilter: 'all' | ChannelType;
  onChannelFilterChange: (v: 'all' | ChannelType) => void;
}) {
  const {
    conversations,
    loading,
    error,
    onRetry,
    onRefresh,
    selectedId,
    onSelect,
    search,
    onSearchChange,
    statusFilter,
    onStatusFilterChange,
    channelFilter,
    onChannelFilterChange,
  } = props;

  return (
    <section className="flex w-full max-w-sm shrink-0 flex-col border-r border-border bg-background-subtle">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-foreground">Inbox</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh conversations">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterPill active={channelFilter === 'all'} onClick={() => onChannelFilterChange('all')}>
            All channels
          </FilterPill>
          <FilterPill active={channelFilter === 'telegram'} onClick={() => onChannelFilterChange('telegram')}>
            Telegram
          </FilterPill>
          <FilterPill active={channelFilter === 'instagram'} onClick={() => onChannelFilterChange('instagram')}>
            Instagram
          </FilterPill>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterPill active={statusFilter === 'all'} onClick={() => onStatusFilterChange('all')}>
            All statuses
          </FilterPill>
          <FilterPill
            active={statusFilter === 'human_attention_required'}
            onClick={() => onStatusFilterChange('human_attention_required')}
          >
            Needs attention
          </FilterPill>
          <FilterPill active={statusFilter === 'ai_handling'} onClick={() => onStatusFilterChange('ai_handling')}>
            AI handling
          </FilterPill>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4">
            <SkeletonList rows={6} />
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorState message={error} onRetry={onRetry} />
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={InboxIcon} title="No conversations" message="Nothing matches the current filters." />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conv.id)}
                  className={cn(
                    'flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-background-muted',
                    selectedId === conv.id && 'border-l-2 border-brand-500 bg-background-muted'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
                      {conv.full_name || 'Unknown customer'}
                      {conv.unread_count > 0 && (
                        <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-foreground-subtle">{formatTime(conv.last_message_at)}</span>
                  </div>
                  <p className="line-clamp-1 text-xs text-foreground-muted">{conv.last_message || 'No messages yet'}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={CHANNEL_TONE[conv.channel]}>{conv.channel}</Badge>
                    <Badge tone={MODE_TONE[conv.mode]}>{MODE_LABEL[conv.mode]}</Badge>
                    <Badge tone="neutral">{STATUS_LABEL[conv.status]}</Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'border-border-strong text-foreground-muted hover:bg-background-muted'
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Middle column — thread + composer
// ---------------------------------------------------------------------------

function ThreadPanel(props: {
  selectedId: string | null;
  detail: ConversationDetail | null;
  messages: MessageRow[];
  pendingDrafts: MessageRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onModeChange: (mode: ControlMode) => void;
  modeUpdating: boolean;
  replyText: string;
  onReplyTextChange: (v: string) => void;
  onSendReply: () => void;
  sending: boolean;
  sendError: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  actingMessageId: string | null;
}) {
  const {
    selectedId,
    detail,
    messages,
    pendingDrafts,
    loading,
    error,
    onRetry,
    onModeChange,
    modeUpdating,
    replyText,
    onReplyTextChange,
    onSendReply,
    sending,
    sendError,
    onApprove,
    onReject,
    actingMessageId,
  } = props;

  if (!selectedId) {
    return (
      <main className="flex flex-1 items-center justify-center bg-background">
        <EmptyState
          icon={MessageSquare}
          title="Select a conversation"
          message="Choose a conversation from the left to view its thread."
        />
      </main>
    );
  }

  if (loading) {
    return (
      <main className="flex flex-1 flex-col bg-background p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <SkeletonList rows={5} />
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main className="flex flex-1 items-center justify-center bg-background p-6">
        <ErrorState message={error ?? 'Conversation not found.'} onRetry={onRetry} />
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background-muted text-sm font-bold text-foreground-muted">
            {(detail.full_name || '?')[0]?.toUpperCase()}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{detail.full_name || 'Unknown customer'}</h3>
            <div className="flex items-center gap-2 text-xs text-foreground-muted">
              <Badge tone={CHANNEL_TONE[detail.channel]}>{detail.channel}</Badge>
              {detail.detected_language && <span>Lang: {detail.detected_language}</span>}
              {detail.detected_intent && <span>Intent: {detail.detected_intent}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground-muted">Mode:</span>
          <div className="flex gap-1 rounded-lg border border-border bg-background-subtle p-1">
            {(['auto', 'approval', 'suggestion', 'human'] as ControlMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={modeUpdating}
                onClick={() => onModeChange(m)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50',
                  detail.mode === m ? 'bg-brand-500 text-white' : 'text-foreground-muted hover:bg-background-muted'
                )}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {detail.status === 'human_attention_required' && (
        <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-700">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>This conversation was escalated and needs human attention.</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No messages yet" message="This conversation has no messages." />
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}

        {pendingDrafts.length > 0 && (
          <div className="mt-6 space-y-3 border-t border-border pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              Pending drafts
            </h4>
            {pendingDrafts.map((draft) => (
              <div key={draft.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-foreground">{draft.content}</p>
                <div className="mt-2 flex items-center justify-between">
                  <Badge tone="warning">{draft.delivery_status}</Badge>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={actingMessageId === draft.id}
                      onClick={() => onReject(draft.id)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={actingMessageId === draft.id}
                      onClick={() => onApprove(draft.id)}
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-border px-5 py-3.5">
        {sendError && (
          <div className="mb-2">
            <ErrorState
              title="Send failed"
              message={sendError}
              onRetry={onSendReply}
              className="items-start py-3 text-left"
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder={
              detail.mode === 'human'
                ? 'Type your reply as human operator...'
                : `Switch to Human mode to send a manual reply (current: ${MODE_LABEL[detail.mode]})`
            }
            disabled={detail.mode !== 'human' || sending}
            value={replyText}
            onChange={(e) => onReplyTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !sending) onSendReply();
            }}
            className="h-10 flex-1 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
          />
          <Button
            disabled={detail.mode !== 'human' || !replyText.trim() || sending}
            onClick={onSendReply}
          >
            <Send className="h-4 w-4" />
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </div>
      </footer>
    </main>
  );
}

function MessageBubble({ message }: { message: MessageRow }) {
  const isCustomer = message.sender === 'customer';
  const isSystem = message.sender === 'system';
  const senderLabel =
    message.sender === 'ai' ? 'AI Agent' : message.sender === 'human_operator' ? 'Human Operator' : message.sender === 'system' ? 'System' : null;

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-background-muted px-3 py-1 text-xs text-foreground-subtle">{message.content}</span>
      </div>
    );
  }

  return (
    <div className={cn('flex', isCustomer ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-lg rounded-2xl px-3.5 py-2.5 text-sm shadow-sm',
          isCustomer
            ? 'rounded-tl-none border border-border bg-background-subtle text-foreground'
            : 'rounded-tr-none bg-brand-500 text-white'
        )}
      >
        {senderLabel && (
          <span className={cn('mb-1 flex items-center gap-1 text-[11px] font-semibold', isCustomer ? 'text-foreground-muted' : 'text-white/80')}>
            {message.sender === 'ai' ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
            {senderLabel}
          </span>
        )}
        <p className="whitespace-pre-wrap">{message.content}</p>
        <span className={cn('mt-1 block text-[10px]', isCustomer ? 'text-foreground-subtle' : 'text-white/70')}>
          {formatTime(message.created_at)}
          {message.ai_confidence != null && ` • Confidence ${(message.ai_confidence * 100).toFixed(0)}%`}
          {message.delivery_status && message.delivery_status !== 'sent' && ` • ${message.delivery_status}`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column — customer/lead context (only rendered where width permits)
// ---------------------------------------------------------------------------

function ContextPanel({ detail, lead }: { detail: ConversationDetail | null; lead: LeadRow | null }) {
  if (!detail) return null;

  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-background-subtle p-4 xl:flex">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Customer</h4>
        <div className="space-y-1.5 rounded-lg border border-border bg-background p-3 text-sm">
          <div className="font-semibold text-foreground">{detail.full_name || 'Unknown'}</div>
          {detail.email && <div className="text-foreground-muted">{detail.email}</div>}
          {detail.phone_number && <div className="text-foreground-muted">{detail.phone_number}</div>}
          {detail.telegram_username && <div className="text-foreground-muted">@{detail.telegram_username} (Telegram)</div>}
          {detail.instagram_username && <div className="text-foreground-muted">@{detail.instagram_username} (Instagram)</div>}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Conversation</h4>
        <div className="space-y-1.5 rounded-lg border border-border bg-background p-3 text-sm text-foreground-muted">
          <div>Status: <Badge tone="neutral">{STATUS_LABEL[detail.status]}</Badge></div>
          {detail.sentiment && <div>Sentiment: {detail.sentiment}</div>}
          {detail.lead_score != null && <div>Lead score: {detail.lead_score}</div>}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Lead</h4>
        {lead ? (
          <a
            href="/leads"
            className="block rounded-lg border border-border bg-background p-3 text-sm text-brand-600 hover:underline"
          >
            View linked lead ({lead.status})
          </a>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-background p-3 text-sm text-foreground-subtle">
            No linked lead for this conversation.
          </p>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
