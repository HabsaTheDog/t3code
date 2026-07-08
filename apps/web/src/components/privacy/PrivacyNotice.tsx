import { DatabaseIcon, MailIcon, ShieldCheckIcon, Undo2Icon } from "lucide-react";

const collected = [
  {
    title: "Usage analytics and click heatmaps",
    body: "Semantic event names; app version and client type; safe route identifiers; setup/provider/feature outcomes; pseudonymous installation identifier; and click targets carrying an explicit data-analytics-id. Session replay is disabled. Prompt and transcript text, page text, pointer movement, scrolling, input values, terminal content, diffs, source files, filenames, filesystem paths, authentication views, arbitrary attributes, console output, network bodies, names, email addresses, Clerk IDs, IP addresses, and provider identities are excluded.",
  },
  {
    title: "Conversation sharing",
    body: "User message text; final assistant text; provider and model; start/completion timestamps and latency; success, interruption, or error state; pseudonymous installation, thread, and turn identifiers. System/developer instructions, tool names/arguments/results, terminal content, diffs, source files, attachments, plan internals, filesystem paths, hidden reasoning, and known credentials are excluded.",
  },
];

export function PrivacyNotice({ compact = false }: { compact?: boolean }) {
  return (
    <article className={compact ? "space-y-7" : "mx-auto max-w-4xl space-y-10"}>
      <header>
        <div className="grid size-12 place-items-center rounded-2xl border bg-card shadow-sm">
          <ShieldCheckIcon className="size-6 text-primary" />
        </div>
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Privacy notice
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
          Consent before collection.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
          Both telemetry categories are optional, independent, and off until you affirmatively
          accept them. Enabling later covers only future activity; Study Buddy never backfills
          pre-consent data.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {collected.map((item) => (
          <div key={item.title} className="rounded-2xl border bg-card p-5 shadow-sm">
            <DatabaseIcon className="size-5 text-primary" />
            <h2 className="mt-4 text-base font-semibold">{item.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-6 rounded-2xl border bg-card p-6 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold">Controller and contact</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Controller: Alvaro Schroll
            <br />
            <a
              className="inline-flex items-center gap-1 underline underline-offset-4"
              href="mailto:dev.habsa@gmail.com"
            >
              <MailIcon className="size-3.5" />
              dev.habsa@gmail.com
            </a>
          </p>
        </div>
        <div>
          <h2 className="text-sm font-semibold">Destination and retention</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Data is sent only to the self-hosted PostHog deployment at studybuddyanalytics.habsa.at.
            Uploaded analytics events, heatmaps, and AI traces are retained for one year. Unsent
            local buffers expire after 30 days and are capped at 250 MB.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <div className="flex items-start gap-3">
          <Undo2Icon className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">Withdrawal and data-subject requests</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Withdraw either category at any time in Settings → Privacy &amp; Data. Capture stops
              immediately and that category’s unsent local queue is deleted. Previously uploaded
              data remains until the one-year retention limit. To request access, correction,
              restriction, deletion, portability, or to object, email dev.habsa@gmail.com. Include
              the installation identifier shown in Privacy &amp; Data settings when available; do
              not send passwords or API keys.
            </p>
          </div>
        </div>
      </section>
    </article>
  );
}
