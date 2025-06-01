import { Telegraf, Context } from "telegraf";

import { eq } from "drizzle-orm";
import { ClientService } from "../client/client-service";
import { bots } from "../database/schema";
import { db } from "../database";
import { MessageService } from "../telegram/message-service";
import { TelegramMediaService } from "../telegram/media-service";
import { UserSessionService } from "./user-session";
import { allowedChannelsService } from "../telegram/allowed-channels-service";
import fs from "fs/promises";

export interface BotData {
  name: string;
  token: string;
  isActive?: boolean;
  webhookUrl?: string;
  startMessage: string;
  file?: string;
}

export interface CustomMessageData {
  message: string;
  channelId?: string;
  buttonText?: string;
  mediaFile?: Buffer;
  mediaType?: "photo" | "video" | "audio" | "document";
  mediaFilename?: string;
}

export class BotService {
  private activeBots: Map<number, Telegraf> = new Map();
  private userService = new ClientService();
  private mediaService = new TelegramMediaService();
  private channelsService = allowedChannelsService;
  private sessionService = new UserSessionService();
  private messageService = new MessageService();
  constructor() {
    const start = async () => {
      const bots = await this.getAllBots();
      bots.map((bot) => bot.isActive && this.startBot(bot.id));
    };
    start();
  }
  async createBot(botData: BotData) {
    try {
      const testBot = new Telegraf(botData.token);
      const botInfo = await testBot.telegram.getMe();

      const newBot = await db
        .insert(bots)
        .values({
          startMessageFile: botData.file,
          startMessage: botData.startMessage,
          name: botData.name,
          token: botData.token,
          username: botInfo.username,
          webhookUrl: botData.webhookUrl,
        })
        .returning();

      return newBot[0];
    } catch (error) {
      throw new Error(`Невалідний токен бота: ${error}`);
    }
  }

  async startBot(botId: number) {
    const botRecord = await this.getBotById(botId);
    if (!botRecord) {
      throw new Error("Бот не знайдений");
    }

    if (this.activeBots.has(botId)) {
      throw new Error("Бот вже запущений");
    }

    const bot = new Telegraf(botRecord.token);

    this.setupBotHandlers(botRecord, bot);

    try {
      if (botRecord.webhookUrl) {
        bot.telegram.setWebhook(botRecord.webhookUrl);
      } else {
        bot.launch();
      }

      this.activeBots.set(botId, bot);
      await db
        .update(bots)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(bots.id, botId));

      return { success: true, message: "Бот успішно запущений" };
    } catch (error) {
      throw new Error(`Помилка запуску бота: ${error}`);
    }
  }

  async stopBot(botId: number) {
    const botRecord = await this.getBotById(botId);
    if (!botRecord) {
      throw new Error("Бот не знайдений");
    }

    const bot = this.activeBots.get(botId);
    if (!bot) {
      throw new Error("Бот не запущений");
    }

    try {
      bot.stop();
      this.activeBots.delete(botId);

      await db
        .update(bots)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(bots.id, botId));

      return { success: true, message: "Бот зупинений" };
    } catch (error) {
      throw new Error(`Помилка зупинки бота: ${error}`);
    }
  }

  async deleteBot(botId: number) {
    // Спочатку зупиняємо бота якщо він запущений
    if (this.activeBots.has(botId)) {
      await this.stopBot(botId);
    }

    const deletedBot = await db
      .delete(bots)
      .where(eq(bots.id, botId))
      .returning();

    if (deletedBot.length === 0) {
      throw new Error("Бот не знайдений");
    }

    return { success: true, message: "Бот видалений", bot: deletedBot[0] };
  }

  async getBotById(botId: number) {
    const bot = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);

    return bot[0] || null;
  }

  async getAllBots() {
    return await db.select().from(bots);
  }

  async updateBot(botId: number, updateData: Partial<BotData>) {
    const updatedBot = await db
      .update(bots)
      .set({
        ...updateData,
        updatedAt: new Date(),
      })
      .where(eq(bots.id, botId))
      .returning();

    return updatedBot[0];
  }

  async sendCustomMessage(
    botId: number,
    userTelegramId: string,
    messageData: CustomMessageData,
  ) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      throw new Error("Бот не запущений");
    }

    try {
      let keyboard;
      const channel = await this.channelsService.getChannelById(
        Number(messageData.channelId),
      );
      if (messageData.channelId) {
        keyboard = {
          inline_keyboard: [
            [
              {
                text: messageData.buttonText || "📺 Переглянути канал",
                callback_data: `channel_${channel.telegramChannelId}`,
              },
            ],
          ],
        };
      }

      let sentMessage;

      if (messageData.mediaFile && messageData.mediaType) {
        const mediaOptions = {
          caption: messageData.message,
          parse_mode: "HTML" as const,
          reply_markup: keyboard,
        };

        switch (messageData.mediaType) {
          case "photo":
            sentMessage = await bot.telegram.sendPhoto(
              userTelegramId,
              { source: messageData.mediaFile },
              mediaOptions,
            );
            break;

          case "video":
            sentMessage = await bot.telegram.sendVideo(
              userTelegramId,
              { source: messageData.mediaFile },
              mediaOptions,
            );
            break;

          case "audio":
            sentMessage = await bot.telegram.sendAudio(
              userTelegramId,
              { source: messageData.mediaFile },
              mediaOptions,
            );
            break;

          case "document":
            sentMessage = await bot.telegram.sendDocument(
              userTelegramId,
              {
                source: messageData.mediaFile,
                filename: messageData.mediaFilename || "document",
              },
              mediaOptions,
            );
            break;
        }
      } else {
        // Відправляємо тільки текстове повідомлення
        sentMessage = await bot.telegram.sendMessage(
          userTelegramId,
          messageData.message,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
          },
        );
      }

      return {
        success: true,
        message: "Повідомлення успішно відправлено",
        messageId: sentMessage.message_id,
      };
    } catch (error) {
      throw new Error(`Помилка відправки повідомлення: ${error}`);
    }
  }

  async broadcastCustomMessage(
    botId: number,
    messageData: CustomMessageData,
    userIds?: string[],
  ) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      throw new Error("Бот не запущений");
    }

    const results = [];
    let targetUsers: string[];

    if (userIds && userIds.length > 0) {
      targetUsers = userIds;
    } else {
      const users = await this.userService.getAllUsers();
      targetUsers = users.map((user) => user.telegramId);
    }

    for (const userId of targetUsers) {
      try {
        const result = await this.sendCustomMessage(botId, userId, messageData);
        results.push({
          userId,
          success: true,
          messageId: result.messageId,
        });
      } catch (error: any) {
        results.push({
          userId,
          success: false,
          error: error?.message,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      success: true,
      message: "Розсилка завершена",
      results,
      totalSent: results.filter((r) => r.success).length,
      totalFailed: results.filter((r) => !r.success).length,
    };
  }

  private setupBotHandlers(botData: any, bot: Telegraf) {
    bot.start(async (ctx: Context) => {
      try {
        const userData = {
          telegramId: ctx.from?.id.toString() || "",
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
          botId: botData.id,
        };

        const user = await this.userService.findOrCreateUser(userData);
        const userId = ctx.from?.id.toString() || "";

        // Очищуємо сесію користувача
        this.sessionService.clearUserSession(userId);

        // Отримуємо список дозволених каналів
        const channels = await this.channelsService.getAllChannels();
        let message;
        if (channels.length === 0) {
          if (botData.startMessageFile) {
            try {
              const imageBuffer = Buffer.from(
                botData.startMessageFile,
                "base64",
              );

              message = await ctx.replyWithPhoto(
                { source: imageBuffer },
                {
                  caption: botData.startMessage,
                },
              );
            } catch (imageError) {
              console.error("Помилка відправки картинки:", imageError);
              message = await ctx.reply(botData.startMessage);
            }
          } else {
            message = await ctx.reply(botData.startMessage);
          }
          this.sessionService.setLastTelegramMessage(
            userId,
            message.message_id,
          );
          return;
        }

        const keyboard = this.createChannelsKeyboard(channels);
        if (botData.startMessageFile) {
          try {
            const imageBuffer = Buffer.from(botData.startMessageFile, "base64");

            message = await ctx.replyWithPhoto(
              { source: imageBuffer },
              {
                caption: botData.startMessage,
                reply_markup: keyboard,
              },
            );
          } catch (imageError) {
            console.error("Помилка відправки картинки:", imageError);
            // Якщо не вдається відправити картинку, відправляємо звичайне повідомлення
            message = await ctx.reply(botData.startMessage, {
              reply_markup: keyboard,
            });
          }
        } else {
          message = await ctx.reply(botData.startMessage, {
            reply_markup: keyboard,
          });
        }

        this.sessionService.setLastTelegramMessage(userId, message.message_id);
      } catch (error) {
        console.error("Помилка обробки /start:", error);
        await ctx.reply("Try later");
      }
    });

    // Обробник inline кнопок
    bot.on("callback_query", async (ctx) => {
      try {
        if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;

        const data = ctx.callbackQuery.data;
        const userId = ctx.from?.id.toString() || "";

        await ctx.answerCbQuery();

        if (data.startsWith("channel_")) {
          await this.handleChannelSelection(ctx, data, userId);
        } else if (data === "next") {
          await this.handleNext(ctx, userId);
        } else if (data === "prev") {
          await this.handlePrevious(ctx, userId);
        } else if (data === "exit") {
          await this.handleExit(ctx, userId);
        }
      } catch (error) {
        console.error("Помилка обробки callback:", error);
      }
    });

    // Обробник помилок
    bot.catch((err: any) => {
      console.error("Помилка бота:", err);
    });

    // Graceful stop
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }

  private createChannelsKeyboard(channels: any[]) {
    const buttons = channels.map((channel) => [
      {
        text: channel.name || `Канал ${channel.telegramChannelId}`,
        callback_data: `channel_${channel.telegramChannelId}`,
      },
    ]);

    return { inline_keyboard: buttons };
  }

  private createNavigationKeyboard(hasNext: boolean, hasPrev: boolean) {
    const buttons = [];

    const navRow = [];
    if (hasPrev) navRow.push({ text: "⬅️", callback_data: "prev" });
    if (hasNext) navRow.push({ text: "➡️", callback_data: "next" });

    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: "❌", callback_data: "exit" }]);

    return { inline_keyboard: buttons };
  }

  private async handleChannelSelection(ctx: any, data: string, userId: string) {
    const channelId = data.replace("channel_", "");
    this.sessionService.setCurrentChannel(userId, channelId);

    // Видаляємо попереднє повідомлення
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити повідомлення:", error);
      }
    }

    // Отримуємо перший пост каналу
    const firstMessage =
      await this.messageService.getFirstMessageByChannelId(channelId);

    if (!firstMessage) {
      const message = await ctx.reply(
        "📭 У цьому каналі немає збережених постів.",
      );
      this.sessionService.setLastTelegramMessage(userId, message.message_id);
      return;
    }

    await this.sendMessageWithNavigation(ctx, firstMessage, userId);
  }

  private async handleNext(ctx: any, userId: string) {
    const currentChannel = this.sessionService.getCurrentChannel(userId);
    const currentMessage = this.sessionService.getCurrentMessage(userId);

    if (!currentChannel || !currentMessage) {
      await ctx.reply("Помилка: втрачено контекст сесії");
      return;
    }

    const nextMessage = await this.messageService.getNextMessage(
      currentChannel,
      currentMessage.messageDate,
    );

    if (!nextMessage) {
      await ctx.answerCbQuery("Це останній пост в каналі");
      return;
    }

    // Видаляємо попереднє повідомлення
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити повідомлення:", error);
      }
    }

    await this.sendMessageWithNavigation(ctx, nextMessage, userId);
  }

  private async handlePrevious(ctx: any, userId: string) {
    const currentChannel = this.sessionService.getCurrentChannel(userId);
    const currentMessage = this.sessionService.getCurrentMessage(userId);

    if (!currentChannel || !currentMessage) {
      await ctx.reply("Помилка: втрачено контекст сесії");
      return;
    }

    const prevMessage = await this.messageService.getPreviousMessage(
      currentChannel,
      currentMessage.messageDate,
    );

    if (!prevMessage) {
      await ctx.answerCbQuery("Це перший пост в каналі");
      return;
    }

    // Видаляємо попереднє повідомлення
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити повідомлення:", error);
      }
    }

    await this.sendMessageWithNavigation(ctx, prevMessage, userId);
  }

  private async handleExit(ctx: any, userId: string) {
    // Видаляємо поточне повідомлення
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити повідомлення:", error);
      }
    }

    // Очищуємо сесію
    this.sessionService.clearUserSession(userId);
  }

  private async sendMessageWithNavigation(
    ctx: any,
    message: any,
    userId: string,
  ) {
    const currentChannel = this.sessionService.getCurrentChannel(userId);

    // Перевіряємо чи є наступні/попередні повідомлення
    const hasNext = !!(await this.messageService.getNextMessage(
      currentChannel!,
      message.date,
    ));
    const hasPrev = !!(await this.messageService.getPreviousMessage(
      currentChannel!,
      message.date,
    ));

    // Зберігаємо поточне повідомлення в сесію
    this.sessionService.setCurrentMessage(userId, message.id, message.date);

    const keyboard = this.createNavigationKeyboard(hasNext, hasPrev);

    // Отримуємо позицію повідомлення
    const position = await this.messageService.getMessagePosition(
      currentChannel!,
      message.date,
    );
    const totalCount = await this.messageService.getMessageCount(
      currentChannel!,
    );

    let messageText = "";

    if (message.text) {
      messageText += message.text;
    }
    // Якщо є медіа, відправляємо з медіа
    if (message.media && message.media.length > 0) {
      const media = message.media[0]; // Беремо перше медіа

      try {
        let sentMessage;

        if (media.localFilePath) {
          const buffer = await fs.readFile(media.localFilePath);

          if (media.type === "photo") {
            sentMessage = await ctx.replyWithPhoto(
              { source: buffer },
              {
                caption: messageText,
                reply_markup: keyboard,
              },
            );
          } else if (media.type === "video") {
            sentMessage = await ctx.replyWithVideo(
              { source: buffer },
              {
                caption: messageText,
                reply_markup: keyboard,
              },
            );
          } else if (media.type === "audio") {
            sentMessage = await ctx.replyWithAudio(
              { source: buffer },
              {
                caption: messageText,
                reply_markup: keyboard,
              },
            );
          } else {
            // Для інших типів відправляємо як документ
            sentMessage = await ctx.replyWithDocument(
              { source: buffer },
              {
                caption: messageText,
                reply_markup: keyboard,
              },
            );
          }
        } else {
          sentMessage = await ctx.reply(messageText, {
            reply_markup: keyboard,
          });
        }

        this.sessionService.setLastTelegramMessage(
          userId,
          sentMessage.message_id,
        );
      } catch (error) {
        console.error("Помилка відправки медіа:", error);
        // Відправляємо тільки текст при помилці
        const sentMessage = await ctx.reply({
          reply_markup: keyboard,
        });
        this.sessionService.setLastTelegramMessage(
          userId,
          sentMessage.message_id,
        );
      }
    } else {
      // Відправляємо тільки текст
      const sentMessage = await ctx.reply(messageText, {
        reply_markup: keyboard,
      });
      this.sessionService.setLastTelegramMessage(
        userId,
        sentMessage.message_id,
      );
    }
  }
  // Метод для отримання активних ботів
  getActiveBots() {
    return this.activeBots;
  }

  // Метод для зупинки всіх ботів при завершенні роботи сервера
  async stopAllBots() {
    for (const [botId, bot] of this.activeBots) {
      try {
        bot.stop();
        await db
          .update(bots)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(bots.id, botId));
      } catch (error) {
        console.error(`Помилка зупинки бота ${botId}:`, error);
      }
    }
    this.activeBots.clear();
  }
}
