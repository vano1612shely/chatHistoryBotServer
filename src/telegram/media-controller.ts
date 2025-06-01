import Elysia, { t } from "elysia";
import { telegramManager } from "./telegram-controller";

export const mediaController = new Elysia()
  .get(
    "/media",
    async ({ query }) => {
      const { type, channelId, limit = "50", offset = "0" } = query;

      const service = Array.from(telegramManager["services"].values())[0]; // Берем первый доступный сервис
      if (!service) {
        return { success: false, message: "No active sessions" };
      }

      const mediaService = service.getMediaService();
      const mediaList = await mediaService.getMediaList({
        type,
        channelId,
        limit: Number(limit),
        offset: Number(offset),
      });

      return { success: true, data: mediaList };
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        channelId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )
  .get("/media/:mediaId", async ({ params: { mediaId }, set }) => {
    const service = Array.from(telegramManager["services"].values())[0];
    if (!service) {
      set.status = 404;
      return { error: "No active sessions" };
    }

    const mediaService = service.getMediaService();
    const result = await mediaService.getMediaBuffer(mediaId);

    if (!result) {
      set.status = 404;
      return { error: "Media not found" };
    }

    const { buffer, mediaInfo } = result;

    set.headers["Content-Type"] =
      mediaInfo.mimeType || "application/octet-stream";
    set.headers["Content-Disposition"] =
      `attachment; filename="${mediaInfo.fileName}"`;
    set.headers["Content-Length"] = buffer.length.toString();

    return new Response(buffer);
  })
  .get("/media/:mediaId/data", async ({ params: { mediaId } }) => {
    const service = Array.from(telegramManager["services"].values())[0];
    if (!service) {
      return { success: false, message: "No active sessions" };
    }

    const mediaService = service.getMediaService();
    const result = await mediaService.getMediaBuffer(mediaId);

    if (!result) {
      return { success: false, message: "Media not found" };
    }

    const { buffer, mediaInfo } = result;

    return {
      success: true,
      data: {
        ...mediaInfo,
        content: buffer.toString("base64"),
        contentType: mediaInfo.mimeType,
      },
    };
  })
  .post(
    "/:sessionId/download-media",
    async ({ params: { sessionId }, body }) => {
      const service = telegramManager.getService(sessionId);
      if (!service) {
        return { success: false, message: "Session not found" };
      }

      const { channelId, messageId } = body;

      try {
        const filePath = await service.downloadMessageMedia(
          channelId,
          messageId,
        );

        if (!filePath) {
          return {
            success: false,
            message: "No media found or download failed",
          };
        }

        return {
          success: true,
          message: "Media downloaded successfully",
          filePath,
        };
      } catch (error) {
        return {
          success: false,
          message: "Failed to download media",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: t.Object({
        channelId: t.String(),
        messageId: t.Number(),
      }),
    },
  )
  .post(
    "/media/:mediaId/duplicate",
    async ({ params: { mediaId }, body }) => {
      const service = Array.from(telegramManager["services"].values())[0];
      if (!service) {
        return { success: false, message: "No active sessions" };
      }

      const mediaService = service.getMediaService();
      const { caption } = body || {};

      try {
        const newMediaId = await mediaService.duplicateMedia(mediaId, caption);

        if (!newMediaId) {
          return { success: false, message: "Failed to duplicate media" };
        }

        return {
          success: true,
          message: "Media duplicated successfully",
          newMediaId,
        };
      } catch (error) {
        return {
          success: false,
          message: "Failed to duplicate media",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: t.Optional(
        t.Object({
          caption: t.Optional(t.String()),
        }),
      ),
    },
  )
  .post(
    "/media/cleanup",
    async ({ body }) => {
      const service = Array.from(telegramManager["services"].values())[0];
      if (!service) {
        return { success: false, message: "No active sessions" };
      }

      const mediaService = service.getMediaService();
      const { olderThanDays = 30 } = body || {};

      try {
        await mediaService.cleanupOldFiles(olderThanDays);
        return {
          success: true,
          message: `Cleanup completed for files older than ${olderThanDays} days`,
        };
      } catch (error) {
        return {
          success: false,
          message: "Cleanup failed",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: t.Optional(
        t.Object({
          olderThanDays: t.Optional(t.Number()),
        }),
      ),
    },
  );
