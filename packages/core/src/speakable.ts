/**
 * Turn an agent's markdown reply into something pleasant to hear.
 * Agents write code blocks, links, tables and bullet lists; reading those
 * aloud verbatim is useless, so we summarise them in words.
 */
export interface SpeakableOptions {
  /** Hard cap on output length; cut at a sentence boundary. Default 600. */
  maxChars?: number;
}

export function toSpeakable(markdown: string, opts: SpeakableOptions = {}): string {
  const maxChars = opts.maxChars ?? 600;
  let s = markdown.replace(/\r\n/g, "\n");

  let codeBlocks = 0;
  s = s.replace(/```[\s\S]*?(```|$)/g, () => {
    codeBlocks++;
    return "\n";
  });
  s = s
    // tables: drop separator rows, keep cell text
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/\|/g, ", ")
    // images and links
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "a link")
    // inline code: keep the words, drop the backticks
    .replace(/`([^`]+)`/g, "$1")
    // headings, quotes, list markers, emphasis, html tags
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm, "$1.")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    // file paths like src/foo/bar.ts:12 read badly; keep the file name
    .replace(/(?:[\w.-]+\/)+([\w.-]+\.\w+)(?::\d+)?/g, "$1")
    .replace(/\.{2,}\s*$/gm, ".")
    .replace(/([.!?])\.+/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (codeBlocks > 0) {
    const note = codeBlocks === 1 ? "I've included a code snippet." : `I've included ${codeBlocks} code snippets.`;
    s = s ? `${s} ${note}` : note;
  }

  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = (lastStop > maxChars * 0.4 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
    s += " The full details are in the chat.";
  }
  return s;
}
