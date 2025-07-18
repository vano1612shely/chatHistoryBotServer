import { Telegraf, Context } from "telegraf";

import { eq, inArray } from "drizzle-orm";
import { ClientService } from "../client/client-service";
import { bots, messageMedia, messages } from "../database/schema";
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

  // Винесена логіка start в окремий метод
  private async handleStartLogic(ctx: Context, botData: any) {
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
            const imageBuffer = Buffer.from(botData.startMessageFile, "base64");

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
        this.sessionService.setLastTelegramMessage(userId, message.message_id);
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
      console.error("Помилка обробки start логіки:", error);
      await ctx.reply("Try later");
    }
  }

  private setupBotHandlers(botData: any, bot: Telegraf) {
    bot.start(async (ctx: Context) => {
      await this.handleStartLogic(ctx, botData);
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
          await this.handleExit(ctx, userId, botData);
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
  private async getValidMessage(
    channelId: string,
    messageDate: Date,
    direction: "next" | "prev" | "first",
  ): Promise<any> {
    let message = null;
    let attempts = 0;
    const maxAttempts = 100; // Захист від нескінченного циклу

    while (attempts < maxAttempts) {
      switch (direction) {
        case "first":
          message =
            await this.messageService.getFirstMessageByChannelId(channelId);
          break;
        case "next":
          message = await this.messageService.getNextMessage(
            channelId,
            messageDate,
          );
          break;
        case "prev":
          message = await this.messageService.getPreviousMessage(
            channelId,
            messageDate,
          );
          break;
      }
      if (!message) {
        return null; // Більше немає повідомлень
      }

      // Перевіряємо чи є контент в повідомленні
      const hasText = message.text && message.text.trim() !== "";
      const hasMedia = message.media && message.media.length > 0;

      if (hasText || hasMedia) {
        return message;
      }

      // Якщо повідомлення порожнє, оновлюємо дату і шукаємо далі
      messageDate = message.date;
      attempts++;
    }

    return null; // Не знайшли валідне повідомлення
  }

  // Updated methods for BotService class

  // Replace the handleChannelSelection method with this:
  private async handleChannelSelection(ctx: any, data: string, userId: string) {
    const channelId = data.replace("channel_", "");
    this.sessionService.setCurrentChannel(userId, channelId);

    // Видаляємо попередні повідомлення
    await this.deletePreviousMessages(ctx, userId);

    // Отримуємо перший валідний пост каналу (фільтрація вже в БД)
    const firstMessage =
      await this.messageService.getFirstMessageByChannelId(channelId);

    if (!firstMessage) {
      // Показуємо повідомлення про відсутність даних з кнопкою "Назад"
      const keyboard = this.createEmptyChannelKeyboard();
      const message = await ctx.reply(
        "📭 У цьому каналі наразі немає збережених постів.\n\n💡 Дані можуть з'явитися пізніше, коли канал буде оновлено.",
        { reply_markup: keyboard },
      );
      this.sessionService.setLastTelegramMessage(userId, message.message_id);
      return;
    }

    await this.sendMessageWithNavigation(ctx, firstMessage, userId);
  }

  // Replace the handleNext method with this:
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

    // Видаляємо попередні повідомлення
    await this.deletePreviousMessages(ctx, userId);

    await this.sendMessageWithNavigation(ctx, nextMessage, userId);
  }

  // Replace the handlePrevious method with this:
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

    // Видаляємо попередні повідомлення
    await this.deletePreviousMessages(ctx, userId);

    await this.sendMessageWithNavigation(ctx, prevMessage, userId);
  }
  // Створюємо клавіатуру тільки з кнопкою "Назад" для порожніх каналів
  private createEmptyChannelKeyboard() {
    return {
      inline_keyboard: [[{ text: "❌ Назад", callback_data: "exit" }]],
    };
  }

  private async handleExit(ctx: any, userId: string, botData: any) {
    // Видаляємо всі попередні повідомлення
    await this.deletePreviousMessages(ctx, userId);

    // Викликаємо ту ж саму логіку що і в /start
    await this.handleStartLogic(ctx, botData);
  }

  // Новий метод для видалення попередніх повідомлень
  private async deletePreviousMessages(ctx: any, userId: string) {
    // Видаляємо повідомлення навігації
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити навігаційне повідомлення:", error);
      }
    }

    // Видаляємо повідомлення медіа-групи
    const mediaGroupMessageIds =
      this.sessionService.getMediaGroupMessageIds(userId);
    if (mediaGroupMessageIds && mediaGroupMessageIds.length > 0) {
      for (const messageId of mediaGroupMessageIds) {
        try {
          await ctx.deleteMessage(messageId);
        } catch (error) {
          console.warn(
            `Не вдалося видалити повідомлення медіа-групи ${messageId}:`,
            error,
          );
        }
      }
      // Очищуємо список ID медіа-групи
      this.sessionService.clearMediaGroupMessageIds(userId);
    }
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

    // FIX: Ensure messageText is never empty
    let messageText = "";
    if (message.text && message.text.trim()) {
      messageText = message.text.trim();
    } else {
      // Fallback text if original message has no text
      messageText = `📄 Пост ${position} з ${totalCount}`;
    }

    // Перевіряємо чи це медіа-група
    if (message.isMediaGroup && message.groupedId) {
      // Отримуємо всі медіа з групи
      const mediaGroupItems = await this.getMediaGroupItems(message.id);

      if (mediaGroupItems && mediaGroupItems.length > 0) {
        try {
          // Готуємо медіа для відправки групою
          const mediaGroup = [];

          for (let i = 0; i < mediaGroupItems.length; i++) {
            const mediaItem = mediaGroupItems[i];

            if (mediaItem.localFilePath) {
              const buffer = await fs.readFile(mediaItem.localFilePath);

              let mediaObject;
              if (mediaItem.type === "photo") {
                mediaObject = {
                  type: "photo" as const,
                  media: { source: buffer },
                  caption: i === 0 ? messageText : undefined, // Підпис тільки до першого елемента
                };
              } else if (mediaItem.type === "video") {
                mediaObject = {
                  type: "video" as const,
                  media: { source: buffer },
                  caption: i === 0 ? messageText : undefined,
                };
              } else if (mediaItem.type === "audio") {
                mediaObject = {
                  type: "audio" as const,
                  media: { source: buffer },
                  caption: i === 0 ? messageText : undefined,
                };
              } else {
                mediaObject = {
                  type: "document" as const,
                  media: { source: buffer },
                  caption: i === 0 ? messageText : undefined,
                };
              }

              mediaGroup.push(mediaObject);
            }
          }

          if (mediaGroup.length > 0) {
            // Відправляємо медіа-групу
            const sentMessages = await ctx.replyWithMediaGroup(mediaGroup);

            // Зберігаємо ID повідомлень медіа-групи
            const messageIds = sentMessages.map((msg: any) => msg.message_id);
            this.sessionService.setMediaGroupMessageIds(userId, messageIds);

            // Відправляємо навігаційні кнопки окремим повідомленням
            const navigationMessage = await ctx.reply(
              `🔘 Навігація: ${position}/${totalCount}`,
              {
                reply_markup: keyboard,
              },
            );

            this.sessionService.setLastTelegramMessage(
              userId,
              navigationMessage.message_id,
            );

            return;
          }
        } catch (error) {
          console.error("Помилка відправки медіа-групи:", error);
          // Fallback - відправляємо як звичайне повідомлення
        }
      }
    }

    // Якщо є звичайне медіа (не група), відправляємо як раніше
    if (message.media && message.media.length > 0 && !message.isMediaGroup) {
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
          // FIX: Ensure we don't send empty text
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
        const sentMessage = await ctx.reply(messageText, {
          reply_markup: keyboard,
        });
        this.sessionService.setLastTelegramMessage(
          userId,
          sentMessage.message_id,
        );
      }
    } else {
      // FIX: Ensure we don't send empty text - this was likely the main issue
      const sentMessage = await ctx.reply(messageText, {
        reply_markup: keyboard,
      });
      this.sessionService.setLastTelegramMessage(
        userId,
        sentMessage.message_id,
      );
    }
  }

  private async getMediaGroupItems(messageId: string) {
    try {
      // Отримуємо основне повідомлення
      const mainMessage = await db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);

      if (mainMessage.length === 0 || !mainMessage[0].isMediaGroup) {
        return null;
      }

      // Отримуємо всі медіа для цього повідомлення та пов'язаних
      const allMessageIds = [messageId];

      // Знаходимо всі дочірні повідомлення
      const childMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.parentMessageId, messageId));

      allMessageIds.push(...childMessages.map((msg) => msg.id));

      // Отримуємо всі медіа файли для цієї групи
      const mediaItems = await db
        .select()
        .from(messageMedia)
        .where(inArray(messageMedia.messageId, allMessageIds))
        .orderBy(messageMedia.createdAt); // Сортуємо за часом створення

      return mediaItems;
    } catch (error) {
      console.error("Помилка отримання медіа-групи:", error);
      return null;
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
