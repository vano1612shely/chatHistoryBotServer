import Elysia, { t } from "elysia";
import { allowedChannelsService } from "./allowed-channels-service"; // Шлях може відрізнятися

const allowedChannelsController = new Elysia({ prefix: "/allowed-channels" })
  .get("/", async () => {
    return allowedChannelsService.getAllChannels();
  })
  .post(
    "/",
    async ({ body, set }) => {
      const { telegramChannelId, name } = body;
      try {
        const newChannel = await allowedChannelsService.createChannel(
          telegramChannelId,
          name,
        );
        return newChannel;
      } catch (error: any) {
        set.status = 400; // Bad Request, e.g. duplicate
        return { success: false, message: error.message };
      }
    },
    {
      body: t.Object({
        telegramChannelId: t.String({
          minLength: 1,
          description:
            "Telegram Channel ID (e.g., '123456789' or '-100123456789')",
        }),
        name: t.Optional(
          t.String({ description: "Descriptive name for the channel" }),
        ),
      }),
    },
  )
  .delete(
    "/:id",
    async ({ params, set }) => {
      const id = parseInt(params.id, 10);
      if (isNaN(id)) {
        set.status = 400;
        return { success: false, message: "Invalid ID format" };
      }
      try {
        return await allowedChannelsService.deleteChannel(id);
      } catch (error: any) {
        set.status = 404; // Not Found
        return { success: false, message: error.message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )
  .get(
    "/:id",
    async ({ params, set }) => {
      const id = parseInt(params.id, 10);
      if (isNaN(id)) {
        set.status = 400;
        return { success: false, message: "Invalid ID format" };
      }
      const channel = await allowedChannelsService.getChannelById(id);
      if (!channel) {
        set.status = 404;
        return { success: false, message: "Channel not found" };
      }
      return channel;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  );

export default allowedChannelsController;
