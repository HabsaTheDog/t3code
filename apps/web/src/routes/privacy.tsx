import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { APP_DISPLAY_NAME } from "../branding";
import { PrivacyNotice } from "../components/privacy/PrivacyNotice";
import { Button } from "../components/ui/button";

function PrivacyRoute() {
  return (
    <main className="fixed inset-0 overflow-y-auto bg-background px-5 py-8 text-foreground sm:px-8 sm:py-12">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col">
        <div className="mb-10 flex items-center justify-between">
          <span className="text-sm font-semibold">{APP_DISPLAY_NAME}</span>
          <Button variant="outline" size="sm" render={<Link to="/" />}>
            <ArrowLeftIcon className="size-4" />
            Back to app
          </Button>
        </div>
        <PrivacyNotice />
      </div>
    </main>
  );
}

export const Route = createFileRoute("/privacy")({
  component: PrivacyRoute,
});
