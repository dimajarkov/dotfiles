import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Compatibility types for the host-side patch used in development. */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    enqueueMessage<T = unknown>(
      message: {
        customType: string;
        content: string | (TextContent | ImageContent)[];
        display: boolean;
        details?: T;
      },
      options?: { deliverAs?: "steer" | "followUp" },
    ): { status: "queued" };
  }
}
