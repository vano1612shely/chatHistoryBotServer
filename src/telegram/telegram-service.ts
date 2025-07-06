import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { db } from "../database";
import { messages, telegramSessions } from "../database/schema";
import { and, eq, inArray } from "drizzle-orm";
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

interface PendingMediaGroup {
  messages: Api.Message[];
  timeout: NodeJS.Timeout;
  channelId: string;
  groupedId: string;
  mainMessage: Api.Message | null; // Основне повідомлення з текстом
}

export class TelegramService extends EventEmitter {
  private client: TelegramClient;
  private isStarted = false;
  private startPromise: Promise<void> | null = null;
  private mediaService: TelegramMediaService;
  private downloadMedia: boolean;
  private stopTimeout: NodeJS.Timeout | null = null;
  private pendingMediaGroups: Map<string, PendingMediaGroup> = new Map();
  private readonly MEDIA_GROUP_TIMEOUT = 3000; // Збільшено до 3 секунд для більш надійної групування

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

        // Проверяем, является ли сообщение частью медиа-группы
        if (message.groupedId) {
          await this.handleMediaGroupMessage(message, channelId);
        } else {
          // Обычное сообщение
          await this.handleSingleMessage(message, channelId);
        }
      }

      // Обработка удаления сообщений
      if (update.className === "UpdateDeleteChannelMessages") {
        const u = update as Api.UpdateDeleteChannelMessages;
        const deletedMessageIds = u.messages;

        try {
          await this.handleDeletedMessages(deletedMessageIds);
        } catch (error) {
          console.error("Error handling deleted messages:", error);
          this.emit("error", error);
        }
      }
    });
  }

  private async handleMediaGroupMessage(
    message: Api.Message,
    channelId: string,
  ) {
    const groupedId = message.groupedId!.toString();
    const groupKey = `${channelId}_${groupedId}`;

    if (this.pendingMediaGroups.has(groupKey)) {
      // Добавляем сообщение к существующей группе
      const pendingGroup = this.pendingMediaGroups.get(groupKey)!;
      pendingGroup.messages.push(message);

      // Визначаємо основне повідомлення (з текстом або перше за замовчуванням)
      if (message.message && message.message.trim()) {
        pendingGroup.mainMessage = message;
      } else if (!pendingGroup.mainMessage) {
        pendingGroup.mainMessage = message;
      }

      // Сбрасываем таймер
      clearTimeout(pendingGroup.timeout);
      pendingGroup.timeout = setTimeout(() => {
        this.processMediaGroup(groupKey);
      }, this.MEDIA_GROUP_TIMEOUT);
    } else {
      // Создаем новую группу
      const timeout = setTimeout(() => {
        this.processMediaGroup(groupKey);
      }, this.MEDIA_GROUP_TIMEOUT);

      this.pendingMediaGroups.set(groupKey, {
        messages: [message],
        timeout,
        channelId,
        groupedId,
        mainMessage: message.message && message.message.trim() ? message : null,
      });
    }
  }

  private async processMediaGroup(groupKey: string) {
    const pendingGroup = this.pendingMediaGroups.get(groupKey);
    if (!pendingGroup) return;

    const { messages: groupMessages, channelId, groupedId } = pendingGroup;

    // Сортируем сообщения по ID для правильного порядка
    groupMessages.sort((a, b) => a.id - b.id);

    try {
      // Визначаємо основне повідомлення
      let mainMessage = pendingGroup.mainMessage || groupMessages[0];

      // Якщо основне повідомлення не має тексту, шукаємо інше з текстом
      if (!mainMessage.message || !mainMessage.message.trim()) {
        const messageWithText = groupMessages.find(
          (msg) => msg.message && msg.message.trim(),
        );
        if (messageWithText) {
          mainMessage = messageWithText;
        }
      }

      // Збираємо весь текст з усіх повідомлень групи
      const allTexts = groupMessages
        .map((msg) => msg.message || "")
        .filter((text) => text.trim())
        .join(" ");

      // Створюємо основне повідомлення
      const [createdMsg] = await db
        .insert(messages)
        .values({
          channelId,
          messageId: mainMessage.id,
          text: allTexts || "", // Використовуємо зібраний текст
          date: new Date(Number(mainMessage.date) * 1000),
          groupedId: groupedId,
          isMediaGroup: true,
        })
        .returning();

      const mediaPaths: string[] = [];
      let hasValidMedia = false;

      // Обрабатываем все медиа из группы
      for (const msg of groupMessages) {
        if (msg.media && this.downloadMedia) {
          // Перевіряємо чи є медіа валідним
          if (this.isValidMediaForDownload(msg.media)) {
            const mediaPath = await this.mediaService.downloadAndSaveMedia(
              this.client,
              msg,
              createdMsg.id,
            );
            if (mediaPath) {
              mediaPaths.push(mediaPath);
              hasValidMedia = true;
            }
          } else {
            console.warn(`⚠️ Пропущено медіа через розмір або тип: ${msg.id}`);
          }
        }
      }

      // Создаем дополнительные записи для остальных сообщений группы (для связи)
      for (const msg of groupMessages) {
        if (msg.id !== mainMessage.id) {
          await db.insert(messages).values({
            channelId,
            messageId: msg.id,
            text: "", // Текст только в главном сообщении
            date: new Date(Number(msg.date) * 1000),
            groupedId: groupedId,
            isMediaGroup: false, // Дополнительные сообщения группы
            parentMessageId: createdMsg.id, // Ссылка на главное сообщение
          });
        }
      }

      this.emit("newMessage", {
        channelId,
        messageId: mainMessage.id,
        text: allTexts,
        date: new Date(Number(mainMessage.date) * 1000),
        media: hasValidMedia,
        mediaPaths,
        isMediaGroup: true,
        mediaGroupCount: groupMessages.length,
        validMediaCount: mediaPaths.length,
      });

      console.log(
        `💬 Нова медіа-група з каналу ${channelId}: "${allTexts}" [${groupMessages.length} елементів, ${mediaPaths.length} медіа]`,
      );
    } catch (error) {
      console.error("Error saving media group:", error);
      this.emit("error", error);
    } finally {
      // Очищаем pending группу
      clearTimeout(pendingGroup.timeout);
      this.pendingMediaGroups.delete(groupKey);
    }
  }

  /**
   * Перевіряє чи підходить медіа для завантаження та відправки
   */
  private isValidMediaForDownload(media: Api.TypeMessageMedia): boolean {
    if (media instanceof Api.MessageMediaDocument) {
      const doc = media.document;
      if (doc instanceof Api.Document) {
        // Перевіряємо розмір файлу (максимум 45 МБ для безпечної відправки)
        const maxSize = 45 * 1024 * 1024; // 45 MB
        //@ts-ignore
        if (doc.size && doc.size > maxSize) {
          console.warn(
            `⚠️ Файл занадто великий: ${doc.size} bytes (макс: ${maxSize})`,
          );
          return false;
        }

        // Для відео додатково перевіряємо розмір (максимум 30 МБ)
        if (doc.mimeType && doc.mimeType.startsWith("video/")) {
          const maxVideoSize = 30 * 1024 * 1024; // 30 MB для відео
          //@ts-ignore
          if (doc.size && doc.size > maxVideoSize) {
            console.warn(
              `⚠️ Відео занадто велике: ${doc.size} bytes (макс для відео: ${maxVideoSize})`,
            );
            return false;
          }
        }
      }
    }
    return true;
  }

  private async handleSingleMessage(message: Api.Message, channelId: string) {
    try {
      const [createdMsg] = await db
        .insert(messages)
        .values({
          channelId,
          messageId: message.id,
          text: message.message || "",
          date: new Date(Number(message.date) * 1000),
          isMediaGroup: false,
        })
        .returning();

      let mediaPath: string | null = null;
      let hasValidMedia = false;

      if (message.media && this.downloadMedia) {
        if (this.isValidMediaForDownload(message.media)) {
          mediaPath = await this.mediaService.downloadAndSaveMedia(
            this.client,
            message,
            createdMsg.id,
          );
          hasValidMedia = !!mediaPath;
        } else {
          console.warn(`⚠️ Пропущено медіа через розмір: ${message.id}`);
        }
      }

      this.emit("newMessage", {
        channelId,
        messageId: message.id,
        text: message.message,
        date: new Date(Number(message.date) * 1000),
        media: hasValidMedia,
        mediaPath,
        isMediaGroup: false,
      });

      const mediaInfo = mediaPath
        ? ` [медіа: ${mediaPath}]`
        : message.media && !hasValidMedia
          ? " [медіа пропущено - великий розмір]"
          : "";

      console.log(
        `💬 Нове повідомлення з каналу ${channelId}: ${message.message}${mediaInfo}`,
      );
    } catch (error) {
      console.error("Error saving message:", error);
      this.emit("error", error);
    }
  }

  getMediaService(): TelegramMediaService {
    return this.mediaService;
  }
  private async handleDeletedMessages(messageIds: number[]): Promise<void> {
    try {
      // Находим сообщения в БД по messageId
      const messagesToDelete = await db
        .select()
        .from(messages)
        .where(inArray(messages.messageId, messageIds));

      if (messagesToDelete.length === 0) {
        console.log(`🔍 Повідомлення для видалення в каналі не знайдено`);
        return;
      }

      const dbMessageIds = messagesToDelete.map((msg) => msg.id);

      // Видаляємо медіа для всіх повідомлень, які будуть видалені
      for (const dbMessageId of dbMessageIds) {
        await this.mediaService.deleteMediaByMessageId(dbMessageId);
      }

      // Видаляємо всі дочірні повідомлення (parentMessageId)
      for (const msg of messagesToDelete) {
        // Видаляємо всі повідомлення, які посилаються на це як на батьківське
        const deletedChildMessages = await db
          .delete(messages)
          .where(eq(messages.parentMessageId, msg.id))
          .returning();

        if (deletedChildMessages.length > 0) {
          console.log(
            `🗑️ Видалено ${deletedChildMessages.length} дочірніх повідомлень для повідомлення ${msg.id}`,
          );
        }
      }

      // Видаляємо основні повідомлення
      const deletedMessages = await db
        .delete(messages)
        .where(inArray(messages.messageId, messageIds))
        .returning();

      console.log(
        `🗑️ Видалено ${deletedMessages.length} повідомлень з каналу: [${messageIds.join(", ")}]`,
      );

      this.emit("messagesDeleted", {
        deletedMessageIds: messageIds,
        deletedCount: deletedMessages.length,
      });
    } catch (error) {
      console.error("Error in handleDeletedMessages:", error);
      throw error;
    }
  }

  async deleteMessage(messageDbId: string): Promise<boolean> {
    try {
      // Видаляємо медіа
      await this.mediaService.deleteMediaByMessageId(messageDbId);

      // Видаляємо всі дочірні повідомлення (parentMessageId)
      const deletedChildMessages = await db
        .delete(messages)
        .where(eq(messages.parentMessageId, messageDbId))
        .returning();

      if (deletedChildMessages.length > 0) {
        console.log(
          `🗑️ Видалено ${deletedChildMessages.length} дочірніх повідомлень для повідомлення ${messageDbId}`,
        );
      }

      // Видаляємо основне повідомлення
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

      // Перевіряємо розмір перед завантаженням
      if (!this.isValidMediaForDownload(message.media)) {
        console.warn(`⚠️ Медіа ${messageId} занадто велике для завантаження`);
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

      // Очищаем все pending медиа-группы
      for (const [key, pendingGroup] of this.pendingMediaGroups) {
        clearTimeout(pendingGroup.timeout);
        // Обрабатываем незавершенные группы
        await this.processMediaGroup(key);
      }
      this.pendingMediaGroups.clear();

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

    // Очищаем pending медиа-группы
    for (const pendingGroup of this.pendingMediaGroups.values()) {
      clearTimeout(pendingGroup.timeout);
    }
    this.pendingMediaGroups.clear();

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
