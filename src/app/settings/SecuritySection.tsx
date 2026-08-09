"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ErrorBanner, SkeletonText } from "@/components/shell";

interface SessionInfo {
  userId: string;
  email: string;
}

/**
 * Security section: basic session/account info only, per issue scope
 * ("no new functionality needed"). Uses the existing GET /api/auth/me.
 */
export function SecuritySection() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) {
          setError(`Failed to load session (${res.status})`);
          return;
        }
        const payload = await res.json();
        setSession(payload.user as SessionInfo);
      } catch {
        setError("Network error — please try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && <SkeletonText lines={2} />}
        {!loading && error && <ErrorBanner message={error} />}
        {!loading && !error && session && (
          <div className="flex items-center gap-3 text-sm text-foreground">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <div>
              <p className="font-medium">{session.email}</p>
              <p className="text-xs text-foreground-muted">Signed in with an active session.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
