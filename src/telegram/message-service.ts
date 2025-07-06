import { db } from "../database";
import { messages, messageMedia, allowedChannels } from "../database/schema";
import {
  eq,
  asc,
  desc,
  and,
  lt,
  gt,
  count,
  isNotNull,
  or,
  ne,
  exists,
  isNull,
} from "drizzle-orm";

export interface MessageWithMedia {
  id: string;
  messageId: number;
  channelId: string;
  text: string | null;
  date: Date;
  isMediaGroup: boolean;
  groupedId: string | null;
  parentMessageId: string | null;
  media: Array<{
    id: string;
    type: string;
    fileId: string;
    caption: string;
    localFilePath: string | null;
    fileName: string | null;
    fileSize: number | null;
    mimeType: string | null;
  }>;
}

export class MessageService {
  // Виправлений метод для створення умови валідних повідомлень
  private getValidMessageCondition() {
    return and(
      // ОСНОВНЕ: Виключаємо дочірні повідомлення медіа-групи
      isNull(messages.parentMessageId),
      // Повідомлення має мати текст АБО медіа
      or(
        // Має непорожній текст
        and(isNotNull(messages.text), ne(messages.text, "")),
        // АБО має медіа (але перевіряємо медіа тільки для батьківських повідомлень)
        and(
          isNull(messages.parentMessageId), // Додаткова перевірка
          exists(
            db
              .select()
              .from(messageMedia)
              .where(eq(messageMedia.messageId, messages.id)),
          ),
        ),
      ),
    );
  }

  async getFirstMessageByChannelId(
    channelId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), this.getValidMessageCondition()),
      )
      .orderBy(asc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getLastMessageByChannelId(
    channelId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), this.getValidMessageCondition()),
      )
      .orderBy(desc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getNextMessage(
    channelId: string,
    currentDate: Date,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          gt(messages.date, currentDate),
          this.getValidMessageCondition(),
        ),
      )
      .orderBy(asc(messages.date))
      .limit(1);
    console.log(message);
    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getPreviousMessage(
    channelId: string,
    currentDate: Date,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          lt(messages.date, currentDate),
          this.getValidMessageCondition(),
        ),
      )
      .orderBy(desc(messages.date))
      .limit(1);

    if (message.length === 0) return null;

    return await this.getMessageWithMedia(message[0].id);
  }

  async getMessageWithMedia(
    messageId: string,
  ): Promise<MessageWithMedia | null> {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (message.length === 0) return null;

    // Отримуємо медіа для батьківського повідомлення
    const parentMedia = await db
      .select()
      .from(messageMedia)
      .where(eq(messageMedia.messageId, messageId));

    // Якщо це медіа-група, отримуємо також медіа з дочірніх повідомлень
    let childMedia: any[] = [];
    if (message[0].isMediaGroup) {
      const childMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.parentMessageId, messageId));

      if (childMessages.length > 0) {
        const childMessageIds = childMessages.map((msg) => msg.id);
        childMedia = await db
          .select()
          .from(messageMedia)
          .where(
            and(
              eq(messageMedia.messageId, childMessageIds[0]), // Використовуємо перший ID
              // Або використовуємо inArray якщо потрібно всі
            ),
          );

        // Для всіх дочірніх повідомлень
        for (const childMsg of childMessages) {
          const media = await db
            .select()
            .from(messageMedia)
            .where(eq(messageMedia.messageId, childMsg.id));
          childMedia.push(...media);
        }
      }
    }

    // Об'єднуємо медіа з батьківського і дочірніх повідомлень
    const allMedia = [...parentMedia, ...childMedia];

    return {
      id: message[0].id,
      messageId: message[0].messageId,
      channelId: message[0].channelId,
      text: message[0].text,
      date: message[0].date,
      isMediaGroup: message[0].isMediaGroup || false,
      groupedId: message[0].groupedId,
      parentMessageId: message[0].parentMessageId,
      media: allMedia.map((m) => ({
        id: m.id,
        type: m.type,
        fileId: m.fileId,
        caption: m.caption || "",
        localFilePath: m.localFilePath,
        fileName: m.fileName,
        fileSize: m.fileSize,
        mimeType: m.mimeType,
      })),
    };
  }

  async getMessageCount(channelId: string): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), this.getValidMessageCondition()),
      );

    return result[0]?.count || 0;
  }

  async getMessagePosition(
    channelId: string,
    messageDate: Date,
  ): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          lt(messages.date, messageDate),
          this.getValidMessageCondition(),
        ),
      );

    return (result[0]?.count || 0) + 1;
  }
}
