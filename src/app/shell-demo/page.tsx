"use client";

import { AppShell, SkeletonList, ErrorBanner, EmptyState } from "@/components/shell";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import { Users } from "lucide-react";

/**
 * Demo route validating AppShell + loading/error/empty state components
 * render together. Not wired to real data — see issue #90 non-goals.
 * Product pages adopt AppShell in UI-04/UI-07.
 */
export default function ShellDemoPage() {
  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Shell demo</h1>
          <p className="text-sm text-foreground-muted">
            Preview of AppShell, sidebar/topbar, and loading/error/empty states.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Loading state</CardTitle>
          </CardHeader>
          <CardContent>
            <SkeletonList rows={3} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Error state</CardTitle>
          </CardHeader>
          <CardContent>
            <ErrorBanner message="Failed to load leads." onRetry={() => {}} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Empty state</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={Users}
              title="No leads yet"
              message="Leads will show up here once connections start syncing."
              action={{ label: "Add a connection", onClick: () => {} }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Badges</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Badge tone="success">Active</Badge>
            <Badge tone="instagram">Instagram</Badge>
            <Badge tone="neutral">Draft</Badge>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
