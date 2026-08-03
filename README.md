# Telegram & Instagram Unified Inbox APIs

Unified messaging API service and dashboard for managing Telegram and Instagram customer interactions with AI classification and lead extraction.

## Local Setup & Development

### Prerequisites
- Node.js v20+
- npm v10+
- PostgreSQL database (optional for local mock testing)

### Installation
1. Clone the repository and install dependencies reproducibly:
   ```bash
   npm ci
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env.local
   ```
   Fill in your API keys in `.env.local`.

3. Run the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the application.

## Quality Gates & Verification

The project includes quality gate commands for build, test, lint, and type safety verification:

- **Linting (ESLint non-interactive)**:
  ```bash
  npm run lint
  ```
- **Type Checking**:
  ```bash
  npm run typecheck
  ```
- **Unit Testing (Vitest)**:
  ```bash
  npm test
  ```
- **Production Build**:
  ```bash
  npm run build
  ```
- **Dependency Audit**:
  ```bash
  npm audit --omit=dev
  ```

### Dependency Audit Notes
Next.js dependencies are pinned to `14.2.35` (the latest security-patched release in the Next.js 14 release line) to preserve framework compatibility without introducing breaking major upgrades. PostCSS and sub-dependencies are overridden to `>=8.5.3`.

## Continuous Integration
GitHub Actions automatically runs all quality gates (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit`) on every push and pull request.
