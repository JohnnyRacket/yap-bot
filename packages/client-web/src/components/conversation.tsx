import { useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Hand, Megaphone, Zap } from "lucide-react";
import type { Item, Snapshot } from "@/client.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { AgentMark } from "@/components/agent-mark.tsx";
import { cn } from "@/lib/utils.ts";

export function Conversation({ snap, onTimings }: { snap: Snapshot; onTimings: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const items = snap.items.filter((i) => i.kind !== "tool" || snap.settings.details);
  const last = items[items.length - 1];
  const waiting = snap.state === "thinking" && last?.kind === "user" && !last.live;

  // follow new text while the view is at the bottom; leave it alone once someone scrolls up
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [snap.items, waiting]);

  return (
    <main
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_20px)]"
    >
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-2 px-4 pt-4 pb-6 sm:px-6">
        {items.length === 0 ? (
          <Empty snap={snap} />
        ) : (
          items.map((item, i) => <Message key={item.id} item={item} prev={items[i - 1]} details={snap.settings.details} onTimings={onTimings} />)
        )}
        {waiting && (
          <div className="msg-in self-start rounded-[1.25rem] rounded-bl-md bg-bubble-bot px-4 py-3">
            <div className="dots flex h-4 items-center gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-2 rounded-full bg-bubble-bot-foreground/50" />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Empty({ snap }: { snap: Snapshot }) {
  const modes = {
    push: "Hold the mic and talk, or type a message.",
    open: "Turn on the mic and just talk, or type a message.",
    wake: `Turn on the mic, then say “${snap.wakeWord}”. Or type a message.`,
  };
  return (
    <div className="msg-in m-auto flex max-w-sm flex-col items-center gap-4 py-10 text-center">
      <AgentMark icon={snap.brand.icon} className="size-20 text-4xl" />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{snap.brand.title}</h1>
        <p className="text-[15px] text-balance text-muted-foreground">{modes[snap.settings.mode]}</p>
      </div>
    </div>
  );
}

function Message({ item, prev, details, onTimings }: { item: Item; prev?: Item; details: boolean; onTimings: () => void }) {
  // a little more room where the speaker changes
  const gap = prev && prev.kind !== item.kind && "mt-2";
  switch (item.kind) {
    case "user":
      return (
        <div className={cn("msg-in max-w-[80%] self-end rounded-[1.25rem] rounded-br-md bg-bubble-user px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap text-bubble-user-foreground sm:max-w-[70%]", item.live && "opacity-60", gap)}>
          {item.text}
        </div>
      );
    case "bot":
      return (
        <div className={cn("flex flex-col items-start gap-1", gap)}>
          <div className="msg-in max-w-[85%] rounded-[1.25rem] rounded-bl-md bg-bubble-bot px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap text-bubble-bot-foreground sm:max-w-[75%]">
            {item.chunks.map((c) => (
              <span
                key={c.id}
                className={cn(
                  "transition-colors duration-300",
                  c.status === "pending" && "opacity-50",
                  c.status === "playing" && "underline decoration-speaking/70 decoration-[1.5px] underline-offset-4",
                  c.status === "unheard" && "line-through opacity-40",
                )}
              >
                {c.text}{" "}
              </span>
            ))}
          </div>
          {(item.interrupted || (details && item.firstSoundMs !== undefined)) && (
            <div className="flex flex-wrap gap-3 px-2 text-[11px] text-muted-foreground">
              {item.interrupted && (
                <span className="inline-flex items-center gap-1">
                  <Hand className="size-3" /> Interrupted
                </span>
              )}
              {details && item.firstSoundMs !== undefined && (
                <button onClick={onTimings} className="inline-flex items-center gap-1 tabular-nums transition-colors hover:text-foreground">
                  <Zap className="size-3" /> {(item.firstSoundMs / 1000).toFixed(2)}s to first sound
                </button>
              )}
            </div>
          )}
        </div>
      );
    case "tool":
      return <ToolCall item={item} gap={gap} />;
    case "announce":
      return (
        <div className="msg-in my-1 flex max-w-[90%] items-start gap-3 self-center rounded-2xl bg-secondary px-4 py-3">
          <Megaphone className="mt-0.5 size-4 flex-none text-speaking" />
          <div className="min-w-0">
            <p className="text-[15px] leading-snug">{item.text}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.source}</p>
          </div>
        </div>
      );
    case "system":
      return <div className="msg-in my-2 self-center text-xs text-muted-foreground">{item.text}</div>;
    case "error":
      return (
        <div className="msg-in my-1 flex max-w-[90%] items-center gap-2 self-center text-[13px] text-destructive">
          <AlertCircle className="size-4 flex-none" />
          {item.text}
        </div>
      );
  }
}

function ToolCall({ item, gap }: { item: Extract<Item, { kind: "tool" }>; gap: string | false | undefined }) {
  const [open, setOpen] = useState(false);
  const json = (v: unknown) => JSON.stringify(v, null, 2) ?? "undefined";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("msg-in max-w-[85%] self-start", gap)}>
      <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
        <span className={cn("size-1.5 rounded-full", item.error ? "bg-destructive" : "bg-good")} />
        <span className="font-mono">{item.name}</span>
        {item.ms !== undefined && <span className="tabular-nums opacity-70">{item.ms} ms</span>}
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 overflow-hidden rounded-xl bg-secondary font-mono text-xs">
        <div className="px-3 py-2">
          <div className="mb-1 font-sans text-[11px] text-muted-foreground">Input</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{json(item.input)}</pre>
        </div>
        <div className="border-t px-3 py-2">
          <div className={cn("mb-1 font-sans text-[11px]", item.error ? "text-destructive" : "text-muted-foreground")}>{item.error ? "Error" : "Output"}</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{item.error ?? json(item.output).slice(0, 4000)}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
