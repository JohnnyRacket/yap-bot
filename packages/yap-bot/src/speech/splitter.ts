// Turns streamed LLM text into speakable pieces as soon as each is complete.

const SENTENCE_END = /[.!?…]+["')\]]*(\s+|$)|\n+/g;
// Text to speech takes longer the longer the piece, so long sentences are split at a comma: the
// first piece early (speech starts sooner), later ones only when long.
const FIRST_CLAUSE_MIN = 30;
const CLAUSE_MIN = 160;
const MAX_PIECE = 220;

/** Strips what reads badly aloud: markdown, emoji, bare URLs. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>~|]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class SentenceSplitter {
  private buf = "";
  private emitted = 0;
  private onPiece: (text: string) => void;

  constructor(onPiece: (text: string) => void) {
    this.onPiece = onPiece;
  }

  push(delta: string) {
    this.buf += delta;
    for (;;) {
      SENTENCE_END.lastIndex = 0;
      const m = SENTENCE_END.exec(this.buf);
      let cut = m ? m.index + m[0].length : -1;
      if (cut < 0 && this.emitted === 0 && this.buf.length >= FIRST_CLAUSE_MIN) {
        const comma = this.buf.lastIndexOf(", ");
        if (comma >= 15) cut = comma + 2;
      }
      if (cut < 0 && this.emitted > 0 && this.buf.length >= CLAUSE_MIN) {
        const comma = this.buf.indexOf(", ", 80);
        if (comma > 0) cut = comma + 2;
      }
      if (cut < 0 && this.buf.length > MAX_PIECE) {
        const space = this.buf.lastIndexOf(" ", MAX_PIECE);
        cut = space > 0 ? space + 1 : MAX_PIECE;
      }
      if (cut < 0) return;
      this.emit(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }

  flush() {
    this.emit(this.buf);
    this.buf = "";
  }

  private emit(raw: string) {
    const text = speakable(raw);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    this.emitted++;
    this.onPiece(text);
  }
}
