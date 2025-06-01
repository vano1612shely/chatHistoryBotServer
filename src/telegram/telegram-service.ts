import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { db } from "../database";
import { messages, messageMedia, telegramSessions } from "../database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { EventEmitter } from "events";
import { TelegramMediaService } from "./media-service";
import { allowedChannelsService } from "./allowed-channels-service";

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  sessionString?: string;
  downloadMedia?: boolean;
  mediaDir?: string;
}

export interface AuthData {
  phoneNumber?: string;
  phoneCode?: string;
  password?: string;
}

export class TelegramService extends EventEmitter {
  private client: TelegramClient;
  private isStarted = false;
  private startPromise: Promise<void> | null = null;
  private mediaService: TelegramMediaService;
  private downloadMedia: boolean;
  private stopTimeout: NodeJS.Timeout | null = null;
  constructor(config: TelegramConfig) {
    super();
    const stringSession = new StringSession(config.sessionString || "");
    this.client = new TelegramClient(
      stringSession,
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5,
      },
    );

    this.downloadMedia = config.downloadMedia ?? true;
    this.mediaService = new TelegramMediaService(config.mediaDir);
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.addEventHandler(async (update: any) => {
      if (update.className === "UpdateNewChannelMessage") {
        const u = update as Api.UpdateNewChannelMessage;
        const message = u.message;
        if (!(message instanceof Api.Message)) return;

        const channelId = message.chatId ? message.chatId.toString() : null;
        if (!channelId) return;
        if (!allowedChannelsService.isChannelAllowed(channelId)) {
          return;
        }
        try {
          const [createdMsg] = await db
            .insert(messages)
            .values({
              channelId,
              messageId: message.id,
              text: message.message || "",
              date: new Date(Number(message.date) * 1000),
            })
            .returning();

          let mediaPath: string | null = null;
          if (message.media && this.downloadMedia) {
            mediaPath = await this.mediaService.downloadAndSaveMedia(
              this.client,
              message,
              createdMsg.id,
            );
          }

          this.emit("newMessage", {
            channelId,
            messageId: message.id,
            text: message.message,
            date: new Date(Number(message.date) * 1000),
            media: !!message.media,
            mediaPath,
          });

          console.log(
            `💬 Нове повідомлення з каналу ${channelId}: ${message.message}${mediaPath ? ` [медіа: ${mediaPath}]` : ""}`,
          );
        } catch (error) {
          console.error("Error saving message:", error);
          this.emit("error", error);
        }
      }

      // Обработка удаления сообщений
      if (update.className === "UpdateDeleteChannelMessages") {
        const u = update as Api.UpdateDeleteChannelMessages;
        const channelId = u.channelId.toString();
        const deletedMessageIds = u.messages;

        if (!allowedChannelsService.isChannelAllowed(channelId)) {
          return;
        }

        try {
          await this.handleDeletedMessages(channelId, deletedMessageIds);
        } catch (error) {
          console.error("Error handling deleted messages:", error);
          this.emit("error", error);
        }
      }
    });
  }

  /**
   * Обрабатывает удаление сообщений из канала
   */
  private async handleDeletedMessages(
    channelId: string,
    messageIds: number[],
  ): Promise<void> {
    try {
      // Находим сообщения в БД по channelId и messageId
      const messagesToDelete = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            inArray(messages.messageId, messageIds),
          ),
        );

      if (messagesToDelete.length === 0) {
        console.log(
          `🔍 Повідомлення для видалення в каналі ${channelId} не знайдено`,
        );
        return;
      }

      const dbMessageIds = messagesToDelete.map((msg) => msg.id);

      for (const dbMessageId of dbMessageIds) {
        await this.mediaService.deleteMediaByMessageId(dbMessageId);
      }

      const deletedMessages = await db
        .delete(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            inArray(messages.messageId, messageIds),
          ),
        )
        .returning();

      console.log(
        `🗑️ Видалено ${deletedMessages.length} повідомлень з каналу ${channelId}: [${messageIds.join(", ")}]`,
      );

      this.emit("messagesDeleted", {
        channelId,
        deletedMessageIds: messageIds,
        deletedCount: deletedMessages.length,
      });
    } catch (error) {
      console.error("Error in handleDeletedMessages:", error);
      throw error;
    }
  }

  getMediaService(): TelegramMediaService {
    return this.mediaService;
  }

  async downloadMessageMedia(
    channelId: string,
    messageId: number,
  ): Promise<string | null> {
    try {
      const entity = await this.client.getEntity(channelId);
      const [message] = await this.client.getMessages(entity, {
        ids: [messageId],
      });

      if (!message || !message.media) {
        return null;
      }

      // Найдем запись в БД
      const dbMessage = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.messageId, messageId),
          ),
        )
        .limit(1);

      if (dbMessage.length === 0) {
        return null;
      }

      return await this.mediaService.downloadAndSaveMedia(
        this.client,
        message,
        dbMessage[0].id,
      );
    } catch (error) {
      console.error("Error downloading media:", error);
      return null;
    }
  }

  async deleteMessage(messageDbId: string): Promise<boolean> {
    try {
      await this.mediaService.deleteMediaByMessageId(messageDbId);

      const deletedRows = await db
        .delete(messages)
        .where(eq(messages.id, messageDbId))
        .returning();

      if (deletedRows.length > 0) {
        console.log(`🗑️ Повідомлення ${messageDbId} видалено вручну`);
        this.emit("messageDeleted", { messageId: messageDbId });
        return true;
      }

      return false;
    } catch (error) {
      console.error("Error deleting message:", error);
      this.emit("error", error);
      return false;
    }
  }
  async deleteMessageByChannelAndId(
    channelId: string,
    messageId: number,
  ): Promise<boolean> {
    try {
      const messageToDelete = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.messageId, messageId),
          ),
        )
        .limit(1);

      if (messageToDelete.length === 0) {
        console.log(
          `🔍 Повідомлення ${messageId} в каналі ${channelId} не знайдено`,
        );
        return false;
      }

      return await this.deleteMessage(messageToDelete[0].id);
    } catch (error) {
      console.error("Error deleting message by channel and id:", error);
      this.emit("error", error);
      return false;
    }
  }

  async start(
    authCallback?: (
      type: "phoneNumber" | "phoneCode" | "password",
    ) => Promise<string>,
  ): Promise<void> {
    if (this.isStarted) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.client
      .start({
        phoneNumber: async () => {
          if (authCallback) {
            return await authCallback("phoneNumber");
          }
          throw new Error("Phone number required");
        },
        password: async () => {
          if (authCallback) {
            return await authCallback("password");
          }
          throw new Error("Password required");
        },
        phoneCode: async () => {
          if (authCallback) {
            return await authCallback("phoneCode");
          }
          throw new Error("Phone code required");
        },
        onError: (err) => {
          console.error("Telegram auth error:", err);
          this.emit("authError", err);
        },
      })
      .then(() => {
        this.isStarted = true;
        console.log("🟢 Telegram userbot запущено!");
        this.emit("started");
      });

    return this.startPromise;
  }
  async delete(sessionId: string): Promise<string> {
    await this.stop();
    const deletedRows = await db
      .delete(telegramSessions)
      .where(eq(telegramSessions.sessionId, sessionId))
      .returning();
    return "Deleted";
  }
  async stop(): Promise<void> {
    if (!this.client || !this.isStarted) {
      console.log("🟡 Telegram client already stopped or not started");
      return;
    }

    try {
      console.log("🔄 Stopping Telegram client...");

      // Створюємо Promise з timeout
      const disconnectPromise = new Promise<void>((resolve, reject) => {
        if (!this.client) {
          resolve();
          return;
        }

        // Встановлюємо timeout на 5 секунд
        this.stopTimeout = setTimeout(() => {
          console.warn("⚠️ Disconnect timeout, forcing stop...");
          this.forceStop();
          resolve(); // Resolve замість reject, щоб не кидати помилку
        }, 5000);

        // Спробуємо нормально відключитися
        this.client
          .disconnect()
          .then(() => {
            if (this.stopTimeout) {
              clearTimeout(this.stopTimeout);
              this.stopTimeout = null;
            }
            console.log("✅ Telegram client disconnected gracefully");
            resolve();
          })
          .catch((error) => {
            if (this.stopTimeout) {
              clearTimeout(this.stopTimeout);
              this.stopTimeout = null;
            }
            console.warn("⚠️ Disconnect error, forcing stop:", error.message);
            this.forceStop();
            resolve(); // Resolve замість reject
          });
      });

      await disconnectPromise;
    } catch (error) {
      console.error("❌ Error during stop:", error);
      this.forceStop();
    } finally {
      // Завжди очищуємо стан
      this.cleanup();
    }
  }
  private forceStop(): void {
    console.log("🚨 Force stopping Telegram client...");

    try {
      if (this.client) {
        if (typeof this.client.destroy === "function") {
          this.client.destroy();
        }
      }
    } catch (error) {
      console.warn("⚠️ Error during force stop:", error);
    }

    this.cleanup();
  }
  private cleanup(): void {
    this.isStarted = false;
    this.startPromise = null;

    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }

    console.log("🔴 Telegram userbot зупинено!");
    this.emit("stopped");
  }
  async quickStop(): Promise<void> {
    console.log("⚡ Quick stopping Telegram client...");
    this.forceStop();
  }
  getSessionString(): string {
    try {
      return this.client.session.save() as unknown as string;
    } catch {
      return "";
    }
  }

  isClientStarted(): boolean {
    return this.isStarted;
  }

  getClient(): TelegramClient {
    return this.client;
  }
}

export default TelegramService;
