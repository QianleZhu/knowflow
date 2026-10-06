// 自有递归文本切分器：依次寻找语义分隔符，最后才按 Unicode 字符兜底。
const CHILD_OVERLAP_CHARS = 120;
const CHILD_TARGET_CHARS = 900;

// 逐级使用段落、换行、句末标点、短语和字符边界切分超长文本。
export function recursiveSplitText(
  text: string,
  targetChars: number,
  separatorIndex = 0,
  preserveWhitespace = false,
): string[] {
  const normalized = preserveWhitespace ? text : text.trim();
  if (normalized.length <= targetChars) return normalized.length === 0 ? [] : [normalized];
  const separators = ["\n\n", "\n", "。", "！", "？", "!", "?", "；", ";", "，", ",", ". ", " "];
  const separator = separators[separatorIndex];
  if (separator === undefined) return hardSplitByCodePoint(normalized, targetChars);

  const pieces = splitKeepingSeparator(normalized, separator);
  if (pieces.length < 2)
    return recursiveSplitText(normalized, targetChars, separatorIndex + 1, preserveWhitespace);
  const output: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const smaller =
      piece.length > targetChars
        ? recursiveSplitText(piece, targetChars, separatorIndex + 1, preserveWhitespace)
        : [piece];
    for (const part of smaller) {
      if (part.length === 0) continue;
      if (current.length > 0 && current.length + part.length > targetChars) {
        output.push(preserveWhitespace ? current : current.trim());
        current = "";
      }
      current += part;
    }
  }
  if (current.trim().length > 0) output.push(preserveWhitespace ? current : current.trim());
  return output.length > 0
    ? output
    : recursiveSplitText(normalized, targetChars, separatorIndex + 1, preserveWhitespace);
}

// 按保留分隔符的方式拆文本，句末标点留在前一句末尾。
function splitKeepingSeparator(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (;;) {
    const index = text.indexOf(separator, start);
    if (index < 0) break;
    const end = index + separator.length;
    if (end > start) pieces.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

// 最后兜底按 Unicode 码点拆分，避免把代理对拆成无效字符。
function hardSplitByCodePoint(text: string, targetChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length > 0 && current.length + character.length > targetChars) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// 识别完整的围栏代码块。
function isFencedCodeBlock(text: string): boolean {
  const lines = text.split("\n");
  return (
    lines.length >= 2 &&
    /^\s*(```+|~~~+)/.test(lines[0] ?? "") &&
    /^(\s*`{3,}|\s*~{3,})$/.test(lines[lines.length - 1] ?? "")
  );
}

// 超长代码只在代码行边界拆分，并为每个子片段补齐代码围栏。
export function splitFencedCode(text: string, targetChars: number): string[] {
  const lines = text.split("\n");
  const opening = lines[0] ?? "```";
  const fence = /^\s*(?:(`{3,})|(~{3,}))(.*)$/.exec(opening);
  if (fence === null || lines.length < 2) return recursiveSplitText(text, targetChars);
  const marker = fence[1] ?? fence[2] ?? "```";
  const closing = marker;
  const bodyEnd = isFencedCodeBlock(text) ? lines.length - 1 : lines.length;
  const body = lines.slice(1, bodyEnd);
  const chunks: string[] = [];
  let current: string[] = [];
  let size = opening.length + closing.length + 2;

  function flush(): void {
    if (current.length > 0) chunks.push([opening, ...current, closing].join("\n"));
    current = [];
    size = opening.length + closing.length + 2;
  }

  for (const line of body) {
    if (current.length > 0 && size + line.length + 1 > targetChars) flush();
    if (line.length + opening.length + closing.length + 2 > targetChars) {
      for (const part of hardSplitByCodePoint(
        line,
        Math.max(1, targetChars - opening.length - closing.length - 2),
      )) {
        if (current.length > 0) flush();
        chunks.push([opening, part, closing].join("\n"));
      }
    } else {
      current.push(line);
      size += line.length + 1;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
}

// 在相邻普通文本子块间复用完整句子，保留上下文且不从句中截取重叠区。
export function addCompleteSentenceOverlap(chunks: string[]): string[] {
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = chunks[index - 1]?.trimEnd() ?? "";
    const matches = [...previous.matchAll(/[^。！？.!?]+[。！？.!?]+[”’"')\]]*/gu)];
    let overlap = "";
    for (let sentenceIndex = matches.length - 1; sentenceIndex >= 0; sentenceIndex -= 1) {
      const sentence = matches[sentenceIndex]?.[0] ?? "";
      if (sentence.length === 0 || overlap.length + sentence.length > CHILD_OVERLAP_CHARS) break;
      overlap = `${sentence}${overlap}`;
    }
    if (overlap.length === 0 || overlap.length + chunk.length > CHILD_TARGET_CHARS) return chunk;
    const separator = /[A-Za-z0-9]$/.test(overlap) && /^[A-Za-z0-9]/.test(chunk) ? " " : "";
    return `${overlap}${separator}${chunk}`;
  });
}
