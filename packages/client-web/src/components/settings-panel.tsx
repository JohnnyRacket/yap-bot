// Settings, the last turn's timings and what the agent can do: beside the chat on wide screens, a
// sheet over it on narrow ones. Laid out as grouped lists.
import { useEffect, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { client, type Snapshot } from "@/client.ts";
import { COLOR_KEYS, currentPreset, PRESETS, resetColors, setColor, setPreset, setTheme, useColors, useTheme, type ColorKey, type ThemeChoice } from "@/theme.ts";
import { Button } from "@/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/utils.ts";

export type PanelTab = "settings" | "turn" | "agent";

export function SettingsPanel({ snap, tab, onTab, onClose }: { snap: Snapshot; tab: PanelTab; onTab: (t: PanelTab) => void; onClose: () => void }) {
  const details = snap.settings.details;
  const tabs: { value: PanelTab; label: string }[] = [
    { value: "settings", label: "Settings" },
    ...(details ? [{ value: "turn" as const, label: "Last turn" }] : []),
    { value: "agent", label: "Agent" },
  ];
  const current = tabs.some((t) => t.value === tab) ? tab : "settings";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 flex-none items-center gap-2 px-4 pt-[env(safe-area-inset-top)] lg:pt-0">
        <Segmented className="flex-1" value={current} options={tabs} onChange={onTab} />
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Hide settings" className="text-muted-foreground hover:text-foreground">
          <PanelRightClose className="size-[18px]" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {current === "settings" && <SettingsTab snap={snap} />}
        {current === "turn" && <TimelineTab snap={snap} />}
        {current === "agent" && <AgentTab snap={snap} />}
      </div>
    </div>
  );
}

/** A segmented control, as on macOS: a grey track with the chosen option raised. */
export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="radiogroup" className={cn("flex rounded-[9px] bg-secondary p-0.5 text-[13px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-1 font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-200",
            o.value === value ? "bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_rgb(0_0_0/0.04)] dark:bg-accent" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Group({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-1.5 px-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>}
      <div className="divide-y overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)] [&>*]:border-border/70">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-xs leading-snug text-muted-foreground">{footer}</p>}
    </section>
  );
}

function Row({ label, note, children, htmlFor }: { label: string; note?: string; children?: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-[15px]">
      <label htmlFor={htmlFor} className="min-w-0">
        <div>{label}</div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </label>
      {children}
    </div>
  );
}

function ActionRow({ children, onClick, tone = "primary", disabled }: { children: React.ReactNode; onClick: () => void; tone?: "primary" | "destructive"; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn("flex min-h-11 w-full items-center px-4 text-left text-[15px] transition-colors hover:bg-secondary/60 disabled:opacity-40", tone === "primary" ? "text-primary" : "text-destructive")}
    >
      {children}
    </button>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The page's own colors (index.css), for the swatches. */
const BUILT_IN = { light: { accent: "#007aff", background: "#ffffff" }, dark: { accent: "#0a84ff", background: "#161618" } };

const COLOR_LABELS: Record<ColorKey, string> = { accent: "Accent", background: "Background", userBubble: "Your messages", botBubble: "Replies" };

/** Theme, a preset palette, and each color on its own (for the theme on screen). */
function Appearance({ theme }: { theme: ThemeChoice }) {
  const colors = useColors();
  const preset = currentPreset();
  const custom = Object.keys(colors.device).length > 0;
  return (
    <Group
      title="Appearance"
      footer={`Colors you pick are for the ${colors.scheme} theme on this device${Object.keys(colors.agent).length ? "; the agent sets the defaults" : ""}. Presets set both themes.`}
    >
      <Row label="Theme">
        <Segmented className="w-48" value={theme} options={THEMES} onChange={setTheme} />
      </Row>
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        {PRESETS.map((p) => {
          // Default: the agent's colors, else the built-in ones
          const base = { ...BUILT_IN[colors.scheme], ...colors.agent };
          const pal = { ...base, ...p.colors[colors.scheme] };
          const accent = pal.accent;
          const bg = pal.background;
          return (
            <button key={p.name} onClick={() => setPreset(p.colors)} aria-pressed={preset === p.name} title={p.name} className="group flex flex-col items-center gap-1.5">
              <span
                className={cn("size-8 rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.15)] ring-offset-2 ring-offset-card transition-shadow", preset === p.name ? "ring-2 ring-foreground/60" : "group-hover:ring-2 group-hover:ring-border")}
                style={{ background: `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)` }}
              />
              <span className={cn("text-[11px]", preset === p.name ? "text-foreground" : "text-muted-foreground")}>{p.name}</span>
            </button>
          );
        })}
      </div>
      {COLOR_KEYS.map((k) => (
        <Row key={k} label={COLOR_LABELS[k]} htmlFor={`color-${k}`}>
          <label className="relative size-7 cursor-pointer rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.2),0_0_0_0.5px_var(--border)]" style={{ background: colors.resolved[k] }}>
            <input id={`color-${k}`} type="color" value={colors.resolved[k]} onChange={(e) => setColor(k, e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </Row>
      ))}
      {custom && <ActionRow onClick={resetColors}>Reset Colors</ActionRow>}
    </Group>
  );
}

function SettingsTab({ snap }: { snap: Snapshot }) {
  const s = snap.settings;
  const theme = useTheme();
  // name, room and echo cancellation wait for Reconnect; the rest applies at once
  const [deviceId, setDeviceId] = useState(s.deviceId);
  const [room, setRoom] = useState(s.room);
  const [echo, setEcho] = useState(s.echo);
  useEffect(() => {
    setDeviceId(s.deviceId);
    setRoom(s.room);
    setEcho(s.echo);
  }, [s.deviceId, s.room, s.echo]);
  const dirty = deviceId !== s.deviceId || room !== s.room || echo !== s.echo;
  const field = "w-36 min-w-0 bg-transparent text-right text-[15px] text-muted-foreground outline-none focus:text-foreground";

  return (
    <>
      <Appearance theme={theme} />

      <Group title="Conversation" footer={s.details ? undefined : "Show details adds tool calls, timings and wake word settings."}>
        {snap.voices.length > 1 && (
          <Row label="Voice" htmlFor="voice">
            <Select value={s.voice} onValueChange={(v) => client.setVoice(v)}>
              <SelectTrigger id="voice" size="sm" className="h-8 max-w-44 border-0 bg-transparent pr-0 text-[15px] text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent" title="Best voices first">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-xl">
                {snap.voices.map((v) => (
                  <SelectItem key={v.id} value={v.id} className="rounded-md">
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        )}
        <Row label="Talking over it interrupts" htmlFor="interruptions">
          <Switch id="interruptions" checked={s.interruptions} onCheckedChange={(v) => client.setInterruptions(v)} />
        </Row>
        <Row label="Show details" htmlFor="details">
          <Switch id="details" checked={s.details} onCheckedChange={(v) => client.setDetails(v)} />
        </Row>
      </Group>

      <Group title="This device" footer="Echo cancellation keeps it from hearing itself; turn it off only with headphones.">
        <Row label="Name" htmlFor="deviceId">
          <input id="deviceId" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={field} autoComplete="off" />
        </Row>
        <Row label="Room" htmlFor="room">
          <input id="room" value={room} onChange={(e) => setRoom(e.target.value)} className={field} autoComplete="off" />
        </Row>
        <Row label="Echo cancellation" htmlFor="echo">
          <Switch id="echo" checked={echo} onCheckedChange={setEcho} />
        </Row>
        <ActionRow onClick={() => client.apply({ deviceId, room, echo })}>{dirty ? "Save and Reconnect" : "Reconnect"}</ActionRow>
      </Group>

      <Group>
        <ActionRow tone="destructive" onClick={() => client.reset()}>
          Forget Conversation
        </ActionRow>
      </Group>
    </>
  );
}

function TimelineTab({ snap }: { snap: Snapshot }) {
  const t = snap.timeline;
  if (!t) return <p className="py-16 text-center text-sm text-muted-foreground">Timings show up after a turn.</p>;
  return (
    <>
      <Group>
        <div className="px-4 py-4">
          <div className="text-xs text-muted-foreground">First sound</div>
          <div className="text-4xl font-semibold tracking-tight tabular-nums">
            {(t.firstSound / 1000).toFixed(2)}
            <span className="ml-0.5 text-xl font-normal text-muted-foreground">s</span>
          </div>
          <div className="text-xs text-muted-foreground">after {t.from}</div>
        </div>
      </Group>
      <Group title="Timeline">
        {t.rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1.4fr)_minmax(3rem,1fr)_3.25rem] items-center gap-3 px-4 py-2 text-[13px]">
            <span className="truncate" title={r.detail}>
              {r.label} {r.detail && <span className="text-muted-foreground">{r.detail}</span>}
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-secondary">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${(r.t / t.span) * 100}%` }} />
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{(r.t / 1000).toFixed(2)}s</span>
          </div>
        ))}
      </Group>
      {t.llm && (
        <Group title="Model">
          <Row label="Rounds">
            <span className="text-muted-foreground tabular-nums">{t.llm.rounds}</span>
          </Row>
          <Row label="New prompt tokens">
            <span className="text-muted-foreground tabular-nums">
              {t.llm.promptTokens ?? "?"} · {Math.round(t.llm.promptMs ?? 0)} ms
            </span>
          </Row>
          <Row label="Generation">
            <span className="text-muted-foreground tabular-nums">{Math.round(t.llm.generationTps ?? 0)} tok/s</span>
          </Row>
        </Group>
      )}
    </>
  );
}

function AgentTab({ snap }: { snap: Snapshot }) {
  const c = snap.capabilities;
  if (!c) return <p className="py-16 text-center text-sm text-muted-foreground">Not connected yet.</p>;
  const groups: [string, string[]][] = [
    ["Tools", c.tools],
    ["Skills", c.skills],
    ["Fastpaths", c.fastpaths],
    ["Schedules", c.schedules],
    ["Triggers", c.triggers],
  ];
  return (
    <>
      {groups.map(([title, xs]) => (
        <Group key={title} title={`${title} (${xs.length})`}>
          {xs.length ? (
            xs.map((x) => (
              <div key={x} className="flex min-h-10 items-center px-4 font-mono text-[13px]">
                {x}
              </div>
            ))
          ) : (
            <div className="flex min-h-10 items-center px-4 text-[13px] text-muted-foreground">None</div>
          )}
        </Group>
      ))}
    </>
  );
}
