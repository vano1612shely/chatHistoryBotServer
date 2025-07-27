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
import { SubscriptionService } from "../subcription/subscription-service";

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
  private subscriptionService = new SubscriptionService();

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
      const usersWithSubscription =
        await this.userService.getUsersWithActiveSubscription();
      targetUsers = usersWithSubscription.map((user) => user.telegramId);
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
  private async showSubscriptionMenu(
    ctx: Context,
    botData: any,
    userId: string,
    user: any,
  ) {
    const subscriptionPlans =
      await this.subscriptionService.getAllSubscriptionPlans();

    const keyboard = {
      inline_keyboard: [
        ...subscriptionPlans.map((plan) => [
          {
            text: `Оформити ${plan.name} (${plan.price} XTR)`,
            callback_data: `subscribe_${plan.id}`,
          },
        ]),
        [{ text: "❌ Закрити", callback_data: "exit" }],
      ],
    };

    const subscriptionMessage = `
💎 Для доступу до контенту потрібна активна підписка!

Доступні плани:
${subscriptionPlans
  .map(
    (plan) => `• ${plan.name}: ${plan.price} XTR (${plan.durationDays} днів)`,
  )
  .join("\n")}

Оберіть план підписки нижче:
`;

    let message;
    if (botData.startMessageFile) {
      try {
        const imageBuffer = Buffer.from(botData.startMessageFile, "base64");
        message = await ctx.replyWithPhoto(
          { source: imageBuffer },
          {
            caption: subscriptionMessage,
            reply_markup: keyboard,
          },
        );
      } catch (imageError) {
        console.error("Помилка відправки картинки:", imageError);
        message = await ctx.reply(subscriptionMessage, {
          reply_markup: keyboard,
        });
      }
    } else {
      message = await ctx.reply(subscriptionMessage, {
        reply_markup: keyboard,
      });
    }

    this.sessionService.setLastTelegramMessage(userId, message.message_id);
  }

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

      // Clear user's session
      this.sessionService.clearUserSession(userId);

      const subscription =
        await this.subscriptionService.getUserActiveSubscription(user.id);
      if (!subscription) {
        await this.showSubscriptionMenu(ctx, botData, userId, user);
        return;
      }
      const channels = await this.channelsService.getAllChannels();
      let message;

      if (channels.length === 0) {
        const keyboard = {
          inline_keyboard: [
            [{ text: "💎 Моя підписка", callback_data: "my_subscription" }],
          ],
        };

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
        return;
      }

      const keyboard = this.createChannelsKeyboard(channels, true);

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
      await ctx.reply("Виникла помилка, спробуйте пізніше");
    }
  }

  private setupBotHandlers(botData: any, bot: Telegraf) {
    bot.start(async (ctx: Context) => {
      await this.handleStartLogic(ctx, botData);
    });

    bot.on("callback_query", async (ctx) => {
      try {
        if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;

        const data = ctx.callbackQuery.data;
        const userId = ctx.from?.id.toString() || "";

        await ctx.answerCbQuery();
        const user = await this.userService.findUserByTelegramId(userId);
        if (!user) return;

        const subscription =
          await this.subscriptionService.getUserActiveSubscription(user.id);
        if (!subscription && !data.startsWith("subscribe_")) {
          await this.showSubscriptionMenu(ctx, botData, userId, user);
          return;
        }
        if (data.startsWith("channel_")) {
          await this.handleChannelSelection(ctx, data, userId);
        } else if (data.startsWith("subscribe_")) {
          await this.handleSubscriptionSelection(ctx, data, userId, botData);
        } else if (data === "my_subscription") {
          await this.handleMySubscription(ctx, userId, botData);
        } else if (data === "next") {
          await this.handleNext(ctx, userId);
        } else if (data === "prev") {
          await this.handlePrevious(ctx, userId);
        } else if (data === "exit") {
          await this.handleExit(ctx, userId, botData);
        }
      } catch (error) {
        console.error("Помилка обробки callback:", error);
        await ctx.reply("Виникла помилка, спробуйте пізніше");
      }
    });

    // Handle successful payment
    bot.on("pre_checkout_query", async (ctx) => {
      try {
        await ctx.answerPreCheckoutQuery(true);
      } catch (error) {
        console.error("Помилка обробки pre_checkout_query:", error);
        await ctx.answerPreCheckoutQuery(false, "Помилка обробки платежу");
      }
    });

    bot.on("successful_payment", async (ctx) => {
      try {
        const userId = ctx.from?.id.toString() || "";
        const user = await this.userService.findUserByTelegramId(userId);
        if (!user) {
          throw new Error("Користувача не знайдено");
        }

        const payment = ctx.message?.successful_payment;
        if (!payment) {
          throw new Error("Дані про платіж відсутні");
        }

        const planId = parseInt(payment.invoice_payload.split("_")[1]);
        const transaction =
          await this.subscriptionService.createSubscriptionTransaction(
            user.id,
            planId,
            payment.telegram_payment_charge_id,
            payment.provider_payment_charge_id,
          );

        await this.subscriptionService.createUserSubscription(
          user.id,
          planId,
          transaction.id,
        );

        await this.deletePreviousMessages(ctx, userId);
        await this.handleStartLogic(ctx, botData);

        await ctx.reply(
          "🎉 Оплата успішна! Ви отримали доступ до всіх функцій бота!",
        );
      } catch (error) {
        console.error("Помилка обробки успішного платежу:", error);
        await ctx.reply(
          "Виникла помилка при обробці платежу. Зверніться до підтримки.",
        );
      }
    });

    bot.catch((err: any) => {
      console.error("Помилка бота:", err);
    });

    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }
  private async handleMySubscription(ctx: any, userId: string, botData: any) {
    const user = await this.userService.findUserByTelegramId(userId);
    if (!user) {
      await ctx.reply("Користувача не знайдено");
      return;
    }

    const subscription =
      await this.subscriptionService.getUserActiveSubscription(user.id);

    if (!subscription) {
      await ctx.reply("У вас немає активної підписки");
      return;
    }

    const endDate = subscription.endDate.toLocaleDateString("uk-UA", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const subscriptionInfo = `
💎 Інформація про підписку

📋 План: ${subscription.planName}
📅 Діє до: ${endDate}
✅ Статус: Активна

Дякуємо за використання нашого сервісу!
`;

    const keyboard = {
      inline_keyboard: [[{ text: "🔙 Назад", callback_data: "exit" }]],
    };

    await this.deletePreviousMessages(ctx, userId);
    const message = await ctx.reply(subscriptionInfo, {
      reply_markup: keyboard,
    });
    this.sessionService.setLastTelegramMessage(userId, message.message_id);
  }
  private async handleSubscriptionSelection(
    ctx: any,
    data: string,
    userId: string,
    botData: any,
  ) {
    const planId = parseInt(data.replace("subscribe_", ""));
    const plan = await this.subscriptionService.getSubscriptionPlanById(planId);

    if (!plan) {
      await ctx.reply("Помилка: План підписки не знайдено");
      return;
    }

    await this.deletePreviousMessages(ctx, userId);

    try {
      // Create invoice
      const invoice = {
        chat_id: ctx.from?.id,
        title: `Підписка ${plan.name}`,
        description:
          plan.description || `Доступ до контенту на ${plan.durationDays} днів`,
        payload: `subscription_${planId}`,
        currency: "XTR",
        prices: [{ label: plan.name, amount: plan.price }],
        max_tip_amount: 0,
        suggested_tip_amounts: [],
      };

      await ctx.replyWithInvoice(invoice);
    } catch (error) {
      console.error("Помилка створення інвойсу:", error);
      await ctx.reply(
        "Помилка при створенні платіжного запиту. Спробуйте пізніше.",
      );
    }
  }

  private createChannelsKeyboard(
    channels: any[],
    includeSubscriptionButton: boolean = false,
  ) {
    const buttons = channels.map((channel) => [
      {
        text: channel.name || `Канал ${channel.telegramChannelId}`,
        callback_data: `channel_${channel.telegramChannelId}`,
      },
    ]);

    if (includeSubscriptionButton) {
      buttons.push([
        { text: "💎 Моя підписка", callback_data: "my_subscription" },
      ]);
    }

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

    await this.deletePreviousMessages(ctx, userId);

    const firstMessage =
      await this.messageService.getFirstMessageByChannelId(channelId);

    if (!firstMessage) {
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

    await this.deletePreviousMessages(ctx, userId);
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

    await this.deletePreviousMessages(ctx, userId);
    await this.sendMessageWithNavigation(ctx, prevMessage, userId);
  }

  private createEmptyChannelKeyboard() {
    return {
      inline_keyboard: [[{ text: "❌ Назад", callback_data: "exit" }]],
    };
  }

  private async handleExit(ctx: any, userId: string, botData: any) {
    await this.deletePreviousMessages(ctx, userId);
    await this.handleStartLogic(ctx, botData);
  }

  private async deletePreviousMessages(ctx: any, userId: string) {
    const lastMessageId = this.sessionService.getLastTelegramMessage(userId);
    if (lastMessageId) {
      try {
        await ctx.deleteMessage(lastMessageId);
      } catch (error) {
        console.warn("Не вдалося видалити навігаційне повідомлення:", error);
      }
    }

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
      this.sessionService.clearMediaGroupMessageIds(userId);
    }
  }

  private async sendMessageWithNavigation(
    ctx: any,
    message: any,
    userId: string,
  ) {
    const currentChannel = this.sessionService.getCurrentChannel(userId);

    const hasNext = !!(await this.messageService.getNextMessage(
      currentChannel!,
      message.date,
    ));
    const hasPrev = !!(await this.messageService.getPreviousMessage(
      currentChannel!,
      message.date,
    ));

    this.sessionService.setCurrentMessage(userId, message.id, message.date);

    const keyboard = this.createNavigationKeyboard(hasNext, hasPrev);
    let messageText = "";
    if (message.text && message.text.trim()) {
      messageText = message.text.trim();
    }
    console.log(message);
    if (message.isMediaGroup && message.groupedId) {
      const mediaGroupItems = await this.getMediaGroupItems(message.id);

      if (mediaGroupItems && mediaGroupItems.length > 0) {
        try {
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
                  caption: i === 0 ? messageText : undefined,
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
            const sentMessages = await ctx.replyWithMediaGroup(mediaGroup);
            const messageIds = sentMessages.map((msg: any) => msg.message_id);
            this.sessionService.setMediaGroupMessageIds(userId, messageIds);

            const navigationMessage = await ctx.reply(`Навігація`, {
              reply_markup: keyboard,
            });

            this.sessionService.setLastTelegramMessage(
              userId,
              navigationMessage.message_id,
            );
            return;
          }
        } catch (error) {
          console.error("Помилка відправки медіа-групи:", error);
        }
      }
    }

    if (message.media && message.media.length > 0 && !message.isMediaGroup) {
      const media = message.media[0];

      try {
        let sentMessage;

        if (media.localFilePath) {
          const buffer = await fs.readFile(media.localFilePath);

          if (media.type === "photo") {
            sentMessage = await ctx.replyWithPhoto(
              { source: buffer },
              { caption: messageText, reply_markup: keyboard },
            );
          } else if (media.type === "video") {
            sentMessage = await ctx.replyWithVideo(
              { source: buffer },
              { caption: messageText, reply_markup: keyboard },
            );
          } else if (media.type === "audio") {
            sentMessage = await ctx.replyWithAudio(
              { source: buffer },
              { caption: messageText, reply_markup: keyboard },
            );
          } else {
            sentMessage = await ctx.replyWithDocument(
              { source: buffer },
              { caption: messageText, reply_markup: keyboard },
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
        const sentMessage = await ctx.reply(messageText, {
          reply_markup: keyboard,
        });
        this.sessionService.setLastTelegramMessage(
          userId,
          sentMessage.message_id,
        );
      }
    } else {
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
      const mainMessage = await db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);

      if (mainMessage.length === 0 || !mainMessage[0].isMediaGroup) {
        return null;
      }

      const allMessageIds = [messageId];

      const childMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.parentMessageId, messageId));

      allMessageIds.push(...childMessages.map((msg) => msg.id));

      const mediaItems = await db
        .select()
        .from(messageMedia)
        .where(inArray(messageMedia.messageId, allMessageIds))
        .orderBy(messageMedia.createdAt);

      return mediaItems;
    } catch (error) {
      console.error("Помилка отримання медіа-групи:", error);
      return null;
    }
  }

  getActiveBots() {
    return this.activeBots;
  }
}
