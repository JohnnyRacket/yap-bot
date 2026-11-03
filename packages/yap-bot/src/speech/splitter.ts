// Turns streamed LLM text into speakable pieces as soon as each is complete.

const SENTENCE_END = /[.!?…]+["')\]]*(\s+|$)|\n+/g;
// Words that end in a period without ending the sentence ("Dr. Seuss", "Mt. Everest").
const ABBREVIATIONS = /(?:^|[\s("'])(?:mr|mrs|ms|dr|prof|st|mt|jr|sr|vs|etc|vol|ch|no|approx|e\.g|i\.e)\.$/i;
// What a new sentence starts with.
const SENTENCE_START = /^["'(\[]?[\p{Lu}\p{N}]/u;
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
      const end = this.sentenceEnd();
      if (end === "wait") return;
      let cut = end;
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

  /**
   * Where the first sentence ends, -1 for nowhere yet, or "wait" when that depends on text still
   * to come. A period after an initial or an abbreviation ("T. Kingfisher", "Dr. Seuss") isn't an
   * end, and neither is one followed by a lowercase word ("Last Chance Live! as an audiobook"), so
   * a possible end at the very end of the text waits for the next word.
   */
  private sentenceEnd(): number | "wait" {
    SENTENCE_END.lastIndex = 0;
    for (let m; (m = SENTENCE_END.exec(this.buf)); ) {
      const cut = m.index + m[0].length;
      if (m[0].startsWith("\n")) return cut;
      if (cut >= this.buf.length) return "wait";
      const before = this.buf.slice(0, m.index + 1);
      if (m[0][0] === "." && (/(?:^|[\s.("'])\p{Lu}\.$/u.test(before) || ABBREVIATIONS.test(before))) continue;
      if (!SENTENCE_START.test(this.buf.slice(cut))) continue;
      return cut;
    }
    return -1;
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
