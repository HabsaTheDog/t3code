import type { StudyBuddySourceInventory } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { SettingsRow } from "./settingsLayout";
import { EmailPermissionControls } from "./EmailPermissionControls";

export function EmailSafetySettings({
  inventory,
  onInventoryChange,
}: {
  inventory: StudyBuddySourceInventory | null;
  onInventoryChange: (inventory: StudyBuddySourceInventory) => void;
}) {
  return (
    <>
      {inventory ? (
        <EmailPermissionControls inventory={inventory} onInventoryChange={onInventoryChange} />
      ) : (
        <div className="px-5 py-5 text-sm text-muted-foreground">Loading email access…</div>
      )}
      <SettingsRow
        title="Sending always asks"
        description="Study Buddy shows the complete email in chat before sending. Approval applies once to those exact recipients and that exact message."
        status={<Badge variant="success">One-time approval</Badge>}
      />
      <SettingsRow
        title="Other mailbox changes"
        description="Delete, move, archive, spam, and read/unread changes are not available to Study Buddy."
        status={<Badge variant="secondary">Always off</Badge>}
      />
    </>
  );
}
