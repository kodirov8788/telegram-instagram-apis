# Telegram & Instagram Customer Communication Agent — Master Issue Roadmap

> **Product Name:** AI Customer Communication Agent (YDeck Sales Operator)  
> **Document Version:** 1.0 (MVP Scope)  
> **Status:** Execution Ready

---

## EPIC 1: Workspace & Core Infrastructure Setup

- [ ] **ISSUE-01: Project Environment Setup & Tech Stack Initialization**
  - **Goal:** Initialize project structure (Next.js 14+ / Fastify API Server, TypeScript, TailwindCSS, ESLint, Prettier, Environment validation).
  - **Deliverables:** Working dev server, folder architecture (`src/app`, `src/api`, `src/lib`, `src/db`), build scripts.

- [ ] **ISSUE-02: Database Schema Design & Supabase PostgreSQL Migration**
  - **Goal:** Design and execute database migrations for Workspaces, Users, Roles (Owner, Admin, Sales Manager, Sales Rep, Support Operator, Analyst), Channels, Customers, Conversations, Messages, Leads, Knowledge Items, and Audit Logs.
  - **Deliverables:** Drizzle/Prisma schema files or raw SQL migrations with pgvector extension enabled.

- [ ] **ISSUE-03: Workspace Management & Multi-Tenancy Isolation Middleware**
  - **Goal:** Build workspace creation, user invitations, role-based authorization middleware (RBAC), and working hours / language settings configuration API.
  - **Deliverables:** REST/GraphQL API endpoints for workspace configuration and tenant isolation middleware.

---

## EPIC 2: Communication Channels Integration Layer

- [ ] **ISSUE-04: Telegram Bot Integration Module**
  - **Goal:** Connect Telegram Bot API via Webhooks. Build webhook signature validator, incoming message handler, and outbound message dispatcher (text, photos, documents).
  - **Deliverables:** `POST /api/webhooks/telegram` endpoint and `TelegramChannelService`.

- [ ] **ISSUE-05: Telegram Special Media & Interactive Payload Handlers**
  - **Goal:** Parse voice messages (transcription trigger), contact sharing, location payloads, and render inline quick-reply buttons.
  - **Deliverables:** Handlers for Telegram attachment types and interactive button triggers.

- [ ] **ISSUE-06: Instagram Business Messaging API Integration**
  - **Goal:** Connect Instagram Direct Messaging via Meta Graph API. Build webhook listener for `messages` and `messaging_postbacks`, plus outbound Graph API DM sender.
  - **Deliverables:** `POST /api/webhooks/instagram` endpoint and `InstagramChannelService` with token refresh.

- [ ] **ISSUE-07: Inbound Message Queue & Normalizer Service**
  - **Goal:** Create unified message schema (`MessageDTO`), queue inbound events into Redis/BullMQ, handle retries, deduplication, and update delivery status.
  - **Deliverables:** Inbound processing queue pipeline with retry mechanism.

---

## EPIC 3: AI Intelligence & Knowledge Base Layer (RAG)

- [ ] **ISSUE-08: Knowledge Base Management & Vector Indexing**
  - **Goal:** Build CRUD for company FAQs, product/service catalogs, delivery policies; convert content into vector embeddings (`text-embedding-3-small` stored in `pgvector`).
  - **Deliverables:** Knowledge base management APIs + Vector similarity search retriever service.

- [ ] **ISSUE-09: Multilingual Language & Intent Classifier Engine**
  - **Goal:** Detect Uzbek (Latin), Russian, English automatically. Classify customer intent into 15+ predefined categories (Greeting, Price, Product Inquiry, Service, Delivery, Complaint, Refund, etc.).
  - **Deliverables:** Intent & Language Classifier service returning structured JSON.

- [ ] **ISSUE-10: Contextual RAG Retrieval & Prompt Guardrails**
  - **Goal:** Build prompt orchestrator enforcing strict zero-hallucination rules (never invent prices or availability), customized tone (Professional, Friendly, Premium, Consultative), and multi-lingual output.
  - **Deliverables:** RAG prompt generator and response synthesis pipeline.

- [ ] **ISSUE-11: AI Response Control Modes Engine**
  - **Goal:** Implement response control modes per intent/category: Automatic Mode (direct send), Approval Mode (save draft for staff), Suggestion Mode (recommendation in UI), and Human Mode (AI mute).
  - **Deliverables:** Control mode state machine determining message routing action.

---

## EPIC 4: Shared Omnichannel Inbox & Real-time Handoff

- [ ] **ISSUE-12: Omnichannel Shared Inbox UI Component**
  - **Goal:** Build real-time Inbox UI displaying Telegram & Instagram chat threads, channel badges, lead score badges, filters (Status, Channel, Language, Unread, Human Attention Required).
  - **Deliverables:** Responsive Inbox page with WebSockets/Server-Sent Events streaming.

- [ ] **ISSUE-13: Conversation Thread View & Operator Control Toggle**
  - **Goal:** Construct chat message view, AI/Human control mode toggle switch, manual message composer, and system activity logs (handoff events, intent detected).
  - **Deliverables:** Interactive chat thread panel component.

- [ ] **ISSUE-14: Automated Human Handoff & Escalation Triggers**
  - **Goal:** Automatically escalate conversation to `human_attention_required` on specific triggers (explicit customer request, low AI confidence, complaint, refund request, angry sentiment). Mute AI responses instantly upon handoff.
  - **Deliverables:** Handoff trigger evaluator & notification payload generator.

- [ ] **ISSUE-15: Operator Notification System**
  - **Goal:** Send real-time notifications to staff via WebSockets (in-app toast) and optional Telegram notification bot for urgent handoffs or high-priority leads.
  - **Deliverables:** Multi-channel notification dispatcher service.

---

## EPIC 5: Lead Capture, Qualification & Follow-up Automation

- [ ] **ISSUE-16: Automated Lead Extraction Engine**
  - **Goal:** Parse natural language chat context to extract structured lead fields: full name, phone number, email, requested product/service, budget, location, and purchase timeline.
  - **Deliverables:** Background entity extractor pipeline updating `Lead` entity.

- [ ] **ISSUE-17: Configurable Lead Qualification & Scoring System**
  - **Goal:** Calculate lead score based on configurable criteria (budget presence, clear intent, contact provided) and assign status: Unqualified, New, Interested, Qualified, High Priority, Lost.
  - **Deliverables:** Lead scoring service & lead list management UI.

- [ ] **ISSUE-18: Automated Conversation Summarizer**
  - **Goal:** Auto-generate structured conversation summaries (customer request, products discussed, questions answered, objections, required next action).
  - **Deliverables:** LLM conversation summary generator updating live in chat details.

- [ ] **ISSUE-19: Rule-Based Follow-Up Automation Engine**
  - **Goal:** Build background job scheduler for rule-based follow-ups (e.g., non-responsive qualified lead after 24h, post-service feedback request, appointment reminder) with opt-out compliance.
  - **Deliverables:** BullMQ follow-up cron scheduler & execution engine.

---

## EPIC 6: Analytics, Audit Logging & Admin Management

- [ ] **ISSUE-20: Analytics Dashboard & Metrics Charts**
  - **Goal:** Build reporting dashboard displaying total conversations, channel split, AI resolution rate, average response time, lead conversion rates, and filterable charts.
  - **Deliverables:** Analytics dashboard UI page with chart visualizations.

- [ ] **ISSUE-21: Comprehensive System Audit Trail**
  - **Goal:** Record all system events (AI response, human response, lead status change, KB edit, handoff, config change) with timestamp, actor, and previous/new values.
  - **Deliverables:** Audit logger middleware & admin audit log viewer table.

- [ ] **ISSUE-22: CSV Data Exporter & Workspace Config UI**
  - **Goal:** Export leads to CSV format; build admin settings interface for AI tone, custom greetings, restricted topics, discount limits, and team permissions.
  - **Deliverables:** Lead export API + Admin settings pages.

---

## EPIC 7: Quality Assurance, Security & Pilot Verification

- [ ] **ISSUE-23: Security Hardening & Tenant Data Isolation**
  - **Goal:** Encrypt channel API tokens at rest, apply rate limiting, validate all input boundaries, enforce row-level security (RLS).
  - **Deliverables:** Security audit pass & data protection implementation.

- [ ] **ISSUE-24: End-to-End Integration & Multi-lingual Testing**
  - **Goal:** Test full user flows across Uzbek, Russian, and English for both Telegram and Instagram channels. Verify automatic handoff, zero hallucination, and lead capture reliability.
  - **Deliverables:** Test suite pass & ready-for-pilot signoff.
