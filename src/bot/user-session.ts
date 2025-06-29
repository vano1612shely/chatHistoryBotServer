export interface UserSession {
  userId: string;
  currentChannelId?: string;
  currentMessageId?: string;
  currentMessageDate?: Date;
  lastMessageId?: number; // ID повідомлення в Telegram для видалення
  mediaGroupMessageIds?: number[]; // ID повідомлень медіа-групи для видалення
}

export class UserSessionService {
  private sessions: Map<string, UserSession> = new Map();

  setUserSession(userId: string, session: Partial<UserSession>): void {
    const existingSession = this.sessions.get(userId) || { userId };
    this.sessions.set(userId, { ...existingSession, ...session });
  }

  getUserSession(userId: string): UserSession | null {
    return this.sessions.get(userId) || null;
  }

  clearUserSession(userId: string): void {
    this.sessions.delete(userId);
  }

  setCurrentChannel(userId: string, channelId: string): void {
    this.setUserSession(userId, {
      currentChannelId: channelId,
      currentMessageId: undefined,
      currentMessageDate: undefined,
    });
  }

  setCurrentMessage(
    userId: string,
    messageId: string,
    messageDate: Date,
  ): void {
    this.setUserSession(userId, {
      currentMessageId: messageId,
      currentMessageDate: messageDate,
    });
  }

  setLastTelegramMessage(userId: string, messageId: number): void {
    this.setUserSession(userId, { lastMessageId: messageId });
  }

  getCurrentChannel(userId: string): string | null {
    const session = this.getUserSession(userId);
    return session?.currentChannelId || null;
  }

  getCurrentMessage(
    userId: string,
  ): { messageId: string; messageDate: Date } | null {
    const session = this.getUserSession(userId);
    if (session?.currentMessageId && session?.currentMessageDate) {
      return {
        messageId: session.currentMessageId,
        messageDate: session.currentMessageDate,
      };
    }
    return null;
  }

  getLastTelegramMessage(userId: string): number | null {
    const session = this.getUserSession(userId);
    return session?.lastMessageId || null;
  }

  // Методи для роботи з медіа-групами
  setMediaGroupMessageIds(userId: string, messageIds: number[]): void {
    this.setUserSession(userId, { mediaGroupMessageIds: messageIds });
  }

  getMediaGroupMessageIds(userId: string): number[] | null {
    const session = this.getUserSession(userId);
    return session?.mediaGroupMessageIds || null;
  }

  clearMediaGroupMessageIds(userId: string): void {
    this.setUserSession(userId, { mediaGroupMessageIds: undefined });
  }

  // Додатковий метод для повного очищення всіх повідомлень
  clearAllMessages(userId: string): void {
    this.setUserSession(userId, {
      lastMessageId: undefined,
      mediaGroupMessageIds: undefined,
    });
  }
}
