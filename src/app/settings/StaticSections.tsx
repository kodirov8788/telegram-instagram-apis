"use client";

import Link from "next/link";
import { Bot, Plug } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

/**
 * Channel configuration entry point — links out to /connections rather than
 * duplicating that page's functionality here.
 */
export function ChannelConfigSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel configuration</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground-muted">
          Manage Instagram and Telegram connections, credentials, and connection tests.
        </p>
        <Link href="/connections">
          <Button variant="secondary" size="sm">
            <Plug className="h-4 w-4" />
            Go to Connections
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * AI behavior/mode settings entry point. There is no workspace-level
 * AI-mode config API today (checked src/app/api and src/lib/services — no
 * ai-mode/ai-behavior route exists), and per issue #95's explicit
 * non-goals, this UI must not invent a new backend endpoint. Placeholder
 * only, per the issue's own guidance for this case.
 */
export function AiBehaviorSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI behavior</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Bot className="h-5 w-5 text-foreground-muted" />
        <p className="text-sm text-foreground-muted">
          Workspace-level AI mode configuration is coming soon.
        </p>
      </CardContent>
    </Card>
  );
}
