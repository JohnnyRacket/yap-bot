import { useEffect, useState, useSyncExternalStore } from "react";
import { client } from "./client.ts";
import { useClient } from "./use-client.ts";
import { Header } from "@/components/header.tsx";
import { Conversation } from "@/components/conversation.tsx";
import { Dock } from "@/components/dock.tsx";
import { SettingsPanel, type PanelTab } from "@/components/settings-panel.tsx";
import { StartOverlay, TokenDialog } from "@/components/overlays.tsx";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

// Wide windows keep the settings beside the chat (open by default, remembered); narrow ones slide them over it.
const wideQuery = matchMedia("(min-width: 1024px)");
const useWide = () =>
  useSyncExternalStore(
    (l) => {
      wideQuery.addEventListener("change", l);
      return () => wideQuery.removeEventListener("change", l);
    },
    () => wideQuery.matches,
  );

export function App() {
  const snap = useClient();
  const wide = useWide();
  const [docked, setDocked] = useState(() => localStorage.getItem("yap-bot-panel") !== "closed");
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<PanelTab>("settings");
  const open = wide ? docked : sheet;

  const setOpen = (o: boolean) => {
    if (wide) {
      setDocked(o);
      localStorage.setItem("yap-bot-panel", o ? "open" : "closed");
    } else setSheet(o);
  };
  const show = (t: PanelTab) => {
    setTab(t);
    setOpen(true);
  };

  // the state colors the page's accents; the agent names the tab and its icon
  useEffect(() => {
    document.documentElement.dataset.mood = snap.state;
  }, [snap.state]);
  useEffect(() => {
    document.title = snap.brand.title;
    const icon = snap.brand.icon;
    const svg = icon && `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${icon}</text></svg>`;
    document.querySelector<HTMLLinkElement>("#favicon")!.href = svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : "/favicon.svg";
  }, [snap.brand]);

  // space bar: push to talk; Esc: stop it talking (unless a dialog or sheet takes the Esc)
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement).matches("input, textarea, select, [contenteditable], [role=combobox]");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && client.snap.settings.mode === "push" && !e.repeat && !typing(e)) {
        e.preventDefault();
        void client.pushDown();
      }
      if (e.code === "Escape" && !document.querySelector("[role=dialog]")) client.interrupt();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && client.snap.settings.mode === "push" && client.snap.pushing) {
        e.preventDefault();
        client.pushUp();
      }
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
    };
  }, []);

  const panel = <SettingsPanel snap={snap} tab={tab} onTab={setTab} onClose={() => setOpen(false)} />;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-dvh bg-background">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* a docked panel has its own hide button */}
          <Header snap={snap} panelOpen={open} showToggle={!(wide && docked)} onTogglePanel={() => setOpen(!open)} />
          <Conversation snap={snap} onTimings={() => show("turn")} />
          <Dock snap={snap} />
        </div>
        {wide && (
          <aside
            aria-label="Settings"
            className={cn("flex-none overflow-hidden border-l bg-canvas transition-[width] duration-300 ease-out", docked ? "w-[22.5rem]" : "w-0 border-l-0")}
            inert={!docked}
          >
            <div className="h-full w-[22.5rem]">{panel}</div>
          </aside>
        )}
      </div>
      {!wide && (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent showCloseButton={false} onOpenAutoFocus={(e) => e.preventDefault()} className="w-[min(24rem,92vw)] gap-0 border-l-0 bg-canvas p-0 sm:max-w-none">
            <SheetTitle className="sr-only">Settings</SheetTitle>
            <SheetDescription className="sr-only">Settings, timings and what the agent can do</SheetDescription>
            {panel}
          </SheetContent>
        </Sheet>
      )}
      <StartOverlay snap={snap} />
      <TokenDialog open={snap.needsToken} />
    </TooltipProvider>
  );
}
