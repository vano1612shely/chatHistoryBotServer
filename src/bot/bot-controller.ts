import { Elysia, t } from "elysia";
import { BotService } from "./bot-service";

const botService = new BotService();

export const telegramBotController = new Elysia({ prefix: "/bots" })
  .decorate("botService", botService)
  .post(
    "/",
    async ({ body, set }) => {
      try {
        const bot = await botService.createBot(body);
        set.status = 201;
        return {
          success: true,
          message: "Бот успішно створений",
          data: bot,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка створення бота",
        };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        startMessage: t.String({ minLength: 1 }),
        file: t.Optional(t.String()),
      }),
    },
  )
  .get("/", async () => {
    try {
      const bots = await botService.getAllBots();
      return {
        success: true,
        data: bots,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Помилка отримання ботів",
      };
    }
  })
  .get(
    "/:id",
    async ({ params, set }) => {
      try {
        const bot = await botService.getBotById(parseInt(params.id));
        if (!bot) {
          set.status = 404;
          return {
            success: false,
            message: "Бот не знайдений",
          };
        }
        return {
          success: true,
          data: bot,
        };
      } catch (error) {
        set.status = 500;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка отримання бота",
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )
  .post(
    "/:id/start",
    async ({ params, set }) => {
      try {
        const result = await botService.startBot(parseInt(params.id));
        return result;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка запуску бота",
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  // Зупинка бота
  .post(
    "/:id/stop",
    async ({ params, set }) => {
      try {
        const result = await botService.stopBot(parseInt(params.id));
        return result;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка зупинки бота",
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  // Оновлення бота
  .put(
    "/:id",
    async ({ params, body, set }) => {
      try {
        const bot = await botService.updateBot(parseInt(params.id), body);
        if (!bot) {
          set.status = 404;
          return {
            success: false,
            message: "Бот не знайдений",
          };
        }
        return {
          success: true,
          message: "Бот успішно оновлений",
          data: bot,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка оновлення бота",
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        token: t.Optional(t.String({ minLength: 1 })),
        webhookUrl: t.Optional(t.String()),
      }),
    },
  )

  // Видалення бота
  .delete(
    "/:id",
    async ({ params, set }) => {
      try {
        const result = await botService.deleteBot(parseInt(params.id));
        return result;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка видалення бота",
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )
  .post(
    "/send-message",
    async ({ body, set }) => {
      try {
        const result = await botService.sendCustomMessage(
          body.botId,
          body.userTelegramId,
          {
            message: body.message,
            channelId: body.channelId,
            mediaFile: body.mediaFile
              ? Buffer.from(body.mediaFile, "base64")
              : undefined,
            mediaType: body.mediaType,
            mediaFilename: body.mediaFilename,
          },
        );
        return result;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка відправки повідомлення",
        };
      }
    },
    {
      body: t.Object({
        botId: t.Number(),
        buttonText: t.Optional(t.String()),
        userTelegramId: t.String({ minLength: 1 }),
        message: t.String({ minLength: 1 }),
        channelId: t.Optional(t.String()),
        mediaFile: t.Optional(t.String()), // base64 encoded file
        mediaType: t.Optional(
          t.Union([
            t.Literal("photo"),
            t.Literal("video"),
            t.Literal("audio"),
            t.Literal("document"),
          ]),
        ),
        mediaFilename: t.Optional(t.String()),
      }),
    },
  )

  // Масова розсилка повідомлень
  .post(
    "/send-message-all",
    async ({ body, set }) => {
      try {
        const result = await botService.broadcastCustomMessage(
          body.botId,
          {
            message: body.message,
            channelId: body.channelId,
            mediaFile: body.mediaFile
              ? Buffer.from(body.mediaFile, "base64")
              : undefined,
            mediaType: body.mediaType,
            mediaFilename: body.mediaFilename,
            buttonText: body.buttonText,
          },
          body.userIds,
        );
        return result;
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка масової розсилки",
        };
      }
    },
    {
      body: t.Object({
        botId: t.Number(),
        buttonText: t.Optional(t.String()),
        message: t.String({ minLength: 1 }),
        channelId: t.Optional(t.String()),
        mediaFile: t.Optional(t.String()),
        mediaType: t.Optional(
          t.Union([
            t.Literal("photo"),
            t.Literal("video"),
            t.Literal("audio"),
            t.Literal("document"),
          ]),
        ),
        mediaFilename: t.Optional(t.String()),
        userIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get("/active/status", () => {
    const activeBots = botService.getActiveBots();
    return {
      success: true,
      data: {
        activeCount: activeBots.size,
        activeBotIds: Array.from(activeBots.keys()),
      },
    };
  });
