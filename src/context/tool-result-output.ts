import type { ToolResultPart } from "ai";

type ToolResultOutput = ToolResultPart["output"];

export function textToolResultTool(value: string): ToolResultOutput {
  return { type: "text", value };
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ? `[denied: ${output.reason}]` : "[denied]";
    case "content":
      return output.value.map(contentPartToText).join("\n");
  }
}

type ToolResultContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];

function contentPartToText(part: ToolResultContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "custom":
      return "[custom content]";
    case "file-id":
    case "image-file-id":
      return `[file-id: ${JSON.stringify(part.fileId)}]`;
    case "file-reference":
    case "image-file-reference":
      return `[file-reference: ${JSON.stringify(part.providerReference)}]`;
    default: {
      // file / file-data / file-url / image-data / image-url 均带 mediaType，
      // 其中 file-url 的 mediaType 为可选
      const mediaType = "mediaType" in part ? part.mediaType : undefined;
      return `[media: ${mediaType ?? "unknown"}]`;
    }
  }
}
