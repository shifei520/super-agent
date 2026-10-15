export interface Chunk {
  id: string
  text: string
  source: string // 来源文件
  index: number // 在文档中的片段位置
  tokenEstimate: number
}

const TARGET_TOKENS = 256;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: Math.floor(text.length / CHARS_PER_TOKEN)
  }
}

export function chunkDocument(source: string, text: string) {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: Chunk[] = []

  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue;

    const isHeading = /^#{1,3}\s/.test(para)
    if ((isHeading && current.length > 50) || (current.length + para.length + 2 > TARGET_CHARS)) {
      chunks.push(makeChunk(current, source, idx++))
      current = ''
    }
    if (para.length > TARGET_CHARS) {
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/)
      let sentBuf = ''
      for (const sent of sentences) {
        if ((sentBuf.length + sent.length + 1 > TARGET_CHARS) && sentBuf.length > 0) {
          chunks.push(makeChunk(sentBuf, source, idx++))
          sentBuf = ''
        }
        sentBuf += (sentBuf ? ' ' : '') + sent
      }
      if (sentBuf.trim()) {
        current = sentBuf.trim()
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed
    }
  }

  if (current.trim()) {
    chunks.push(makeChunk(current.trim(), source, idx++))
  }

  return chunks
}