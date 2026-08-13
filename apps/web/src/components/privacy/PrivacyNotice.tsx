import { DatabaseIcon, MailIcon, ShieldCheckIcon, Undo2Icon } from "lucide-react";

const collected = [
  {
    title: "Usage analytics",
    body: "If you turn this on, we receive the Study Buddy version you use, which screens and features work or fail, the rough area of the screen you clicked, and which marked buttons you use. Session replay is disabled. We do not collect exact page addresses, what you type, page or course content, mouse movement, scrolling, voice transcripts, passwords, file contents or paths, names, email addresses, or sign-in details.",
  },
  {
    title: "Conversation sharing",
    body: "If you turn this on, we receive the messages you send, Study Buddy’s final replies, feedback you leave, the AI model used, timing and outcome, summaries with sensitive details removed, and basic details about files Study Buddy creates or changes. We do not receive passwords, private instructions, behind-the-scenes tool activity, terminal output, file contents, attachments, full file paths, or hidden reasoning.",
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
          You choose what to share.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
          Both sharing options are optional and start turned off. If you turn one on, Study Buddy
          only shares new activity from that point forward. It never goes back and shares earlier
          activity.
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
          <h2 className="text-sm font-semibold">Who looks after your data</h2>
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
          <h2 className="text-sm font-semibold">Where it goes and how long we keep it</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Shared data goes only to Study Buddy’s private analytics service at
            studybuddyanalytics.habsa.at. We keep shared usage and conversation data for one year.
            Data waiting on your device is removed after 30 days and can use no more than 250 MB.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <div className="flex items-start gap-3">
          <Undo2Icon className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-semibold">Change your mind or ask about your data</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Turn either option off at any time in Settings → Privacy &amp; Data. Study Buddy stops
              collecting it immediately and removes anything of that type still waiting on your
              device. Data already sent is kept for up to one year. To ask for a copy, correction,
              restriction, transfer, or deletion of your data—or to object to its use—email
              dev.habsa@gmail.com. Include your Study Buddy ID from Privacy &amp; Data settings if
              you have one. Never email passwords or sign-in codes.
            </p>
          </div>
        </div>
      </section>
    </article>
  );
}
