import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, formatApiError } from "../lib/api-client.js";
import { withAuthGuard } from "../lib/auth-guard.js";

export function registerMediaTools(server: McpServer): void {
  server.tool(
    "upload-media-from-url",
    "Fetch a remote image/video URL and upload it to your Mention account (returns fileId for create-post).",
    {
      url: z.string().url().describe("Public http(s) image or video URL"),
    },
    withAuthGuard(async ({ url }) => {
      try {
        const result = await api.post<Record<string, unknown>>("/posts/intent-media", { url });
        const fileId = result.fileId;
        return {
          content: [{
            type: "text" as const,
            text: `Uploaded. fileId: ${String(fileId)}\ncontentType: ${String(result.contentType ?? "unknown")}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "upload-media",
    "Upload base64-encoded image/video bytes to your Mention account (returns fileId for create-post).",
    {
      base64: z.string().describe("Base64 payload or data: URL"),
      mimeType: z.string().describe("MIME type, e.g. image/jpeg"),
      filename: z.string().optional().describe("Optional filename"),
    },
    withAuthGuard(async ({ base64, mimeType, filename }) => {
      try {
        const result = await api.post<Record<string, unknown>>("/posts/intent-media", {
          base64,
          mimeType,
          ...(filename ? { filename } : {}),
        });
        return {
          content: [{
            type: "text" as const,
            text: `Uploaded. fileId: ${String(result.fileId)}\ncontentType: ${String(result.contentType ?? mimeType)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "search-gifs",
    "Search GIFs to attach to a post (requires authorization).",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional(),
    },
    withAuthGuard(async ({ query, limit }) => {
      try {
        const result = await api.get<{ gifs?: Array<Record<string, unknown>> }>("/gifs/search", {
          q: query,
          ...(limit !== undefined ? { limit } : {}),
        });
        const gifs = result.gifs ?? [];
        if (gifs.length === 0) {
          return { content: [{ type: "text" as const, text: "No GIFs found." }] };
        }
        const lines = gifs.map((g) => {
          const id = String(g.klipyId ?? g.id ?? "");
          const title = String(g.title ?? g.slug ?? id);
          return `- ${title} (klipyId: ${id})`;
        });
        return { content: [{ type: "text" as const, text: `GIFs (${gifs.length}):\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    "use-gif",
    "Import a GIF to your account and get a fileId for create-post (requires authorization).",
    {
      klipyId: z.string(),
      slug: z.string().optional(),
      title: z.string().optional(),
      mp4Url: z.string().optional(),
      previewUrl: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    withAuthGuard(async (body) => {
      try {
        const result = await api.post<Record<string, unknown>>("/gifs/use", body);
        return {
          content: [{
            type: "text" as const,
            text: `GIF ready. fileId: ${String(result.fileId ?? "")}\ngifId: ${String(result.gifId ?? "")}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
