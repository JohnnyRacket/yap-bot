import { useEffect, useRef, useState } from "react";
import { ArrowUp, Ear, Hand, Mic, Radio, Square } from "lucide-react";
import type { ListenMode, SessionState, WakeDetector } from "yap-bot/protocol";
import { client, touch, type Snapshot } from "@/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { Segmented } from "@/components/settings-panel.tsx";
import { cn } from "@/lib/utils.ts";

const MODES: { value: ListenMode; label: string; icon: typeof Mic }[] = [
  { value: "wake", label: "Wake word", icon: Ear },
  { value: "open", label: "Open mic", icon: Radio },
  { value: "push", label: "Push to talk", icon: Hand },
];

const DETECTORS: { value: WakeDetector; label: string }[] = [
  { value: "device", label: "On this device" },
  { value: "keyword", label: "Server keyword spotter" },
  { value: "both", label: "Server, either detector" },
  { value: "transcript", label: "Server transcript match" },
];

export function Dock({ snap }: { snap: Snapshot }) {
  const { settings: s } = snap;
  const busy = snap.state === "thinking" || snap.state === "speaking";
  return (
    <footer className="flex-none px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5 rounded-[1.375rem] bg-card p-3 shadow-elevation sm:p-3.5">
        <div className="flex items-center gap-2.5">
          <MicButton snap={snap} />
          <Composer />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                onClick={() => client.interrupt()}
                aria-label="Stop"
                className={cn("size-10 flex-none transition-all duration-200", busy ? "scale-100 opacity-100" : "pointer-events-none -ml-2.5 w-0 scale-75 opacity-0")}
                tabIndex={busy ? 0 : -1}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop speaking (Esc)</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Segmented
            value={s.mode}
            onChange={(m) => client.setMode(m)}
            options={MODES.map((m) => ({
              value: m.value,
              title: m.label,
              label: (
                <>
                  <m.icon className="size-3.5 flex-none" />
                  <span className="max-[440px]:sr-only">{m.label}</span>
                </>
              ),
            }))}
          />
          <StateLabel state={snap.state} awake={snap.awake && s.mode === "wake"} />
        </div>

        <div className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-muted-foreground">
          <span className="text-pretty">{snap.hint}</span>
          {s.mode === "wake" && snap.heard && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className={cn("font-medium", snap.heard.tone === "woke" ? "text-good" : snap.heard.tone === "miss" ? "text-warn" : "")}>{snap.heard.label}</span>
              <span className="truncate">{snap.heard.text}</span>
              <span className="tabular-nums opacity-60">{snap.heard.at}</span>
            </span>
          )}
          {s.mode === "wake" && s.details && (
            <Select value={s.detector} onValueChange={(v) => client.setDetector(v as WakeDetector)}>
              <SelectTrigger size="sm" className="ml-auto h-6 gap-1 rounded-md border-0 bg-secondary px-2 text-xs shadow-none dark:bg-secondary" aria-label="How wake mode notices the wake word">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-xl">
                {DETECTORS.map((d) => (
                  <SelectItem key={d.value} value={d.value} className="rounded-md text-xs">
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {s.details && snap.spotterNote && <span className="w-full opacity-80">{snap.spotterNote}</span>}
        </div>
      </div>
    </footer>
  );
}

const STATE_LABEL: Record<SessionState, string> = { idle: "Idle", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };

function StateLabel({ state, awake }: { state: SessionState; awake: boolean }) {
  return (
    <div className="inline-flex items-center gap-1.5 pr-1 text-xs font-medium text-mood" aria-live="polite">
      {state === "thinking" ? (
        <span className="dots flex items-center gap-0.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1 rounded-full bg-current" />
          ))}
        </span>
      ) : state === "speaking" ? (
        <span className="eq flex h-2.5 items-end gap-px">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-full w-0.5 rounded-full bg-current" />
          ))}
        </span>
      ) : (
        <span className={cn("size-1.5 rounded-full bg-current", state === "listening" && "animate-pulse")} />
      )}
      {STATE_LABEL[state]}
      {state === "listening" && awake && <span className="font-normal opacity-70">· awake</span>}
    </div>
  );
}

/** Push mode: hold it. Otherwise it switches the mic on and off. A thin ring follows the mic level. */
function MicButton({ snap }: { snap: Snapshot }) {
  const ref = useRef<HTMLButtonElement>(null);
  const push = snap.settings.mode === "push";
  const live = snap.micOn && (!push || snap.pushing);
  const armed = snap.micOn && push && !snap.pushing;

  useEffect(
    () =>
      client.onLevel((peak) => {
        ref.current?.style.setProperty("--level", String(Math.min(1, peak * 1.6)));
      }),
    [],
  );

  const label = push ? "Hold to talk" : snap.micOn ? "Turn the mic off" : "Turn the mic on";
  // nothing happens until the mic is on: say so, right where it is
  const nudge = !snap.micOn ? (push ? "Hold here to talk" : `${touch ? "Tap" : "Click"} here to start chatting`) : null;
  return (
    <div className="relative flex-none">
      {nudge && (
        <div role="note" className="nudge pointer-events-none absolute bottom-full left-0 z-30 mb-3 animate-in fade-in slide-in-from-bottom-1">
          <div className="relative rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-background shadow-lg">
            {nudge}
            <span className="absolute top-full left-[1.1rem] -mt-1 size-2.5 rotate-45 rounded-[2px] bg-foreground" />
          </div>
        </div>
      )}
      <button
        ref={ref}
        data-live={live}
        aria-label={label}
        aria-pressed={live}
        title={push && !touch ? "Hold to talk (or hold space)" : label}
        className={cn(
          "orb grid touch-none place-items-center rounded-full transition-[background-color,color,transform] duration-200 select-none active:scale-95",
          touch ? "size-12" : "size-10",
          live ? "bg-mood text-white" : "bg-secondary text-foreground hover:bg-accent",
          armed && "ring-[1.5px] ring-mood ring-offset-2 ring-offset-card",
          !snap.micOn && "ring-[1.5px] ring-primary/60 ring-offset-2 ring-offset-card",
        )}
        onPointerDown={(e) => {
          if (!push) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          void client.pushDown();
        }}
        onPointerUp={() => push && client.pushUp()}
        onPointerCancel={() => push && client.pushUp()}
        onClick={() => void client.toggleMic()}
        onContextMenu={(e) => push && e.preventDefault()}
      >
        <Mic className={touch ? "size-[22px]" : "size-[18px]"} />
      </button>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState("");
  return (
    <form
      className="relative flex min-w-0 flex-1 items-center"
      onSubmit={(e) => {
        e.preventDefault();
        void client.sendText(text);
        setText("");
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message"
        aria-label="Message"
        autoComplete="off"
        enterKeyHint="send"
        className="h-10 w-full min-w-0 rounded-full border border-input bg-field pr-11 pl-4 text-base transition-[background-color,border-color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-primary/15 sm:text-[15px]"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!text.trim()}
        className="absolute right-1 grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-all duration-150 disabled:scale-75 disabled:opacity-0"
      >
        <ArrowUp className="size-4" strokeWidth={2.5} />
      </button>
    </form>
  );
}
