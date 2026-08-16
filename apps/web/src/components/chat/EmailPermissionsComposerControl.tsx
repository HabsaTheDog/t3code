import type { StudyBuddySourceInventory } from "@t3tools/contracts";
import { ChevronDownIcon, MailIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { EmailPermissionControls } from "../settings/EmailPermissionControls";
import { emailPermissionState } from "../settings/StudyBuddyEmailPermissions.logic";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Spinner } from "../ui/spinner";

export function EmailPermissionsComposerControl({ compact }: { compact: boolean }) {
  const [inventory, setInventory] = useState<StudyBuddySourceInventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void ensureLocalApi()
      .server.getStudyBuddySourceInventory()
      .then((next) => {
        if (!canceled) setInventory(next);
      })
      .catch(() => {
        if (!canceled) setError("Email access settings are unavailable right now.");
      });
    return () => {
      canceled = true;
    };
  }, []);

  const label = useMemo(() => emailAccessLabel(inventory), [inventory]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            data-analytics-id="chat.email-access"
            variant="ghost"
            size="sm"
            type="button"
            className="shrink-0 whitespace-nowrap px-2 font-medium text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            aria-label="Email access permissions"
            title="Choose what Study Buddy may do with each email account"
          />
        }
      >
        <MailIcon className="size-4" aria-hidden="true" />
        <span className={compact ? "sr-only" : undefined}>{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(23rem,calc(100vw-1rem))]"
      >
        <div className="mb-3">
          <PopoverTitle className="text-sm">Email access</PopoverTitle>
          <PopoverDescription className="mt-1 text-xs leading-relaxed">
            Choose what Study Buddy may do with each account. Changes apply in every chat.
          </PopoverDescription>
        </div>
        {!inventory && !error ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Loading email accounts…
          </div>
        ) : error ? (
          <p className="py-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : inventory ? (
          <EmailPermissionControls
            inventory={inventory}
            onInventoryChange={setInventory}
            surface="composer"
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

export function emailAccessLabel(inventory: StudyBuddySourceInventory | null): string {
  if (!inventory) return "Email access";
  const sources = inventory.sources.filter((source) => source.kind === "email");
  if (sources.length !== 1) return "Email access";
  const source = sources[0]!;
  const connection = inventory.connections.find(
    (candidate) => candidate.id === source.connectionId,
  );
  const permissions = emailPermissionState(source, connection);
  if (permissions.send) return "Email approval";
  if (permissions.draft) return "Email drafts";
  if (permissions.read) return "Read email";
  return "Email off";
}
