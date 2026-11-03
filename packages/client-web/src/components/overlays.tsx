import { useState } from "react";
import { KeyRound, Volume2 } from "lucide-react";
import { client, type Snapshot } from "@/client.ts";
import { AgentMark } from "@/components/agent-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Browsers only play sound after a tap: speech that arrived before one waits for this. */
export function StartOverlay({ snap }: { snap: Snapshot }) {
  if (!snap.needsTap) return null;
  return (
    <div className="material fixed inset-0 z-50 grid place-items-center animate-in fade-in">
      <button onClick={() => client.unlock()} className="group flex flex-col items-center gap-4 rounded-3xl p-10 outline-none">
        <AgentMark icon={snap.brand.icon} className="size-24 text-5xl transition-transform group-hover:scale-105 group-active:scale-95" />
        <span className="flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-[15px] font-medium text-primary-foreground">
          <Volume2 className="size-4" /> Tap to start
        </span>
        <span className="text-[13px] text-muted-foreground">{snap.brand.title} has something to say</span>
      </button>
    </div>
  );
}

/** The agent wants its access code. */
export function TokenDialog({ open }: { open: boolean }) {
  const [code, setCode] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && client.giveToken("")}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            client.giveToken(code);
          }}
          className="grid gap-5"
        >
          <DialogHeader>
            <div className="mb-2 grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <KeyRound className="size-6" />
            </div>
            <DialogTitle>Access code</DialogTitle>
            <DialogDescription>This assistant needs its access code. It's remembered on this device.</DialogDescription>
          </DialogHeader>
          <Input autoFocus type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code" className="h-10 rounded-lg" />
          <DialogFooter>
            <Button type="submit" disabled={!code.trim()} className="w-full">
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
