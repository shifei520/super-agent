import { chunkDocument } from "../rag/chunker";
import { embed, EmbeddingFn } from "../rag/embedder";
import { SqliteVectorStore } from "../rag/sqlite-store";
import { ToolDefinition } from "./tool-registry";
import fs from 'node:fs'

export function createRagTools(vectorStore: SqliteVectorStore, embedFn: EmbeddingFn): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description: '将文档导入知识库。内容会被分块、向量化后存储。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async ({ path }: { path: string }) => {
      const text = fs.readFileSync(path, 'utf-8');
      const chunks = chunkDocument(path, text);
      const embeddings = await embed(embedFn, chunks.map(c => c.text));
      vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
      return `已导入 ${chunks.length} 个文档片段。知识库共 ${vectorStore.size()} 个片段。`;
    },
  };

  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        top_k: { type: 'number', description: '返回结果数量（默认 5）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
      if (vectorStore.size() === 0) return '知识库为空，请先导入文档。';
      const results = await vectorStore.hybridSearch(embedFn, query, top_k || 5);
      return results.map((r, i) =>
        `[${i + 1}] 来源: ${r.chunk.source} | 分数: ${r.score.toFixed(3)}\n${r.chunk.text}`
      ).join('\n\n---\n\n');
    },
  };

  return [ragIngestTool, ragSearchTool];
}
