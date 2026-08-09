"use client";

import { AppShell } from "@/components/shell";
import { WorkspaceProfileSection } from "./WorkspaceProfileSection";
import { MembersSection } from "./MembersSection";
import { InvitationsSection } from "./InvitationsSection";
import { ChannelConfigSection, AiBehaviorSection } from "./StaticSections";
import { SecuritySection } from "./SecuritySection";

export function SettingsPageClient() {
  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-foreground-muted">
            Workspace profile, team, invitations, channels, and account security.
          </p>
        </div>

        <WorkspaceProfileSection />
        <MembersSection />
        <InvitationsSection />
        <ChannelConfigSection />
        <AiBehaviorSection />
        <SecuritySection />
      </div>
    </AppShell>
  );
}
