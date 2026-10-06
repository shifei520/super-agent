import type { ToolDefinition } from "./tool-registry";

import { pickSearchTool, webFetchTool } from "./web-search-tools";
import {
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./file-tools";
import { globTool, grepTool } from "./file-search-tools";
import { bashTool } from "./shell-tools";
import { startPreviewTool, stopPreviewTool } from "./preview-tools";

export const allTools: ToolDefinition[] = [
  // weatherTool,
  // calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  startPreviewTool,
  stopPreviewTool,
  pickSearchTool(),
  webFetchTool,
];
