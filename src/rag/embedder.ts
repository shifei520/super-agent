export type EmbeddingFn = (texts: string[]) => Promise<number[][]>

export const DIMS = 128;

export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  return async (texts: string[]) => {
    const resp = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: texts,
          dimensions: DIMS,
        }),
      },
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Embedding 请求失败 (${resp.status} ${resp.statusText}): ${body.slice(0, 300)}`,
      );
    }
    const { data } = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.map((item) => item.embedding);
  };
}

const embedCache = new Map<string, number[]>()
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
  const result: number[][] = new Array(texts.length)
  const uncached: { idx: number; text: string }[] = []

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i])
    if (cached) {
      result[i] = cached
    } else {
      uncached.push({ idx: i, text: texts[i] })
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map(u => u.text))
    for (let i = 0; i < uncached.length; i++) {
      result[uncached[i].idx] = vectors[i]
      embedCache.set(uncached[i].text, vectors[i])
    }
  }

  return result
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}