import Elysia, { t } from "elysia";
import TelegramService from "./telegram-service";
import { db } from "../database";
import { messageMedia, messages, telegramSessions } from "../database/schema";
import { eq } from "drizzle-orm";

interface AuthState {
  awaitingAuth: boolean;
  authType?: "phoneNumber" | "phoneCode" | "password";
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
}

class TelegramManager {
  private services = new Map<string, TelegramService>();
  private authStates = new Map<string, AuthState>();
  private initialized = false;

  async initialize() {
    if (this.initialized) return;

    console.log("🔄 Initializing Telegram Manager...");

    try {
      // Load all active sessions from database
      const activeSessions = await db
        .select()
        .from(telegramSessions)
        .where(eq(telegramSessions.isActive, true));

      console.log(
        `📋 Found ${activeSessions.length} active sessions in database`,
      );

      for (const session of activeSessions) {
        try {
          console.log(`🚀 Attempting to restore session: ${session.sessionId}`);

          const service = new TelegramService({
            apiId: session.apiId,
            apiHash: session.apiHash,
            sessionString: session.sessionString || undefined,
          });

          this.services.set(session.sessionId, service);
          this.authStates.set(session.sessionId, { awaitingAuth: false });

          // Try to start the service
          await this.startServiceWithAuth(session.sessionId, service, session);
        } catch (error) {
          console.error(
            `❌ Failed to restore session ${session.sessionId}:`,
            error,
          );

          // If session restoration fails, mark as inactive but keep the record
          await db
            .update(telegramSessions)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(telegramSessions.sessionId, session.sessionId));
        }
      }
    } catch (error) {
      console.error("❌ Failed to initialize Telegram Manager:", error);
    }

    this.initialized = true;
    console.log("✅ Telegram Manager initialized");
  }

  private async startServiceWithAuth(
    sessionId: string,
    service: TelegramService,
    sessionData: any,
  ) {
    try {
      await service.start(async (type) => {
        console.log(`🔐 Auth required for session ${sessionId}, type: ${type}`);

        // If we need phone number and we have it saved, use it
        if (type === "phoneNumber" && sessionData.phoneNumber) {
          return sessionData.phoneNumber;
        }

        // For other auth types, set awaiting state
        this.authStates.set(sessionId, {
          awaitingAuth: true,
          authType: type,
        });

        return new Promise<string>((resolve, reject) => {
          this.setAuthState(sessionId, { resolve, reject });

          setTimeout(
            () => {
              this.setAuthState(sessionId, { awaitingAuth: false });
              reject(new Error("Auth timeout"));
            },
            5 * 60 * 1000,
          );
        });
      });

      // Update session string after successful start
      const newSessionString = service.getSessionString();
      if (newSessionString && newSessionString !== sessionData.sessionString) {
        await db
          .update(telegramSessions)
          .set({
            sessionString: newSessionString,
            updatedAt: new Date(),
          })
          .where(eq(telegramSessions.sessionId, sessionId));
      }

      console.log(`✅ Successfully started session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Failed to start session ${sessionId}:`, error);
      throw error;
    }
  }

  async createService(
    sessionId: string,
    apiId: number,
    apiHash: string,
    phoneNumber?: string,
    sessionString?: string,
  ): Promise<TelegramService> {
    // Save or update session in database
    const existingSession = await db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.sessionId, sessionId))
      .limit(1);

    if (existingSession.length > 0) {
      // Update existing session
      await db
        .update(telegramSessions)
        .set({
          apiId,
          apiHash,
          phoneNumber,
          sessionString,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(telegramSessions.sessionId, sessionId));
    } else {
      // Create new session
      await db.insert(telegramSessions).values({
        sessionId,
        apiId,
        apiHash,
        phoneNumber,
        sessionString,
        isActive: true,
      });
    }

    const service = new TelegramService({ apiId, apiHash, sessionString });
    this.services.set(sessionId, service);
    this.authStates.set(sessionId, { awaitingAuth: false });

    return service;
  }

  getService(sessionId: string): TelegramService | undefined {
    return this.services.get(sessionId);
  }

  getAuthState(sessionId: string): AuthState | undefined {
    return this.authStates.get(sessionId);
  }

  setAuthState(sessionId: string, state: Partial<AuthState>): void {
    const currentState = this.authStates.get(sessionId) || {
      awaitingAuth: false,
    };
    this.authStates.set(sessionId, { ...currentState, ...state });
  }

  async removeService(sessionId: string): Promise<void> {
    const service = this.services.get(sessionId);
    if (service) {
      await service.stop();
      this.services.delete(sessionId);
      this.authStates.delete(sessionId);
    }

    // Mark session as inactive in database (don't delete, keep for history)
    await db
      .update(telegramSessions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(telegramSessions.sessionId, sessionId));
  }

  async updateSessionString(
    sessionId: string,
    sessionString: string,
  ): Promise<void> {
    await db
      .update(telegramSessions)
      .set({ sessionString, updatedAt: new Date() })
      .where(eq(telegramSessions.sessionId, sessionId));
  }

  async updatePhoneNumber(
    sessionId: string,
    phoneNumber: string,
  ): Promise<void> {
    await db
      .update(telegramSessions)
      .set({ phoneNumber, updatedAt: new Date() })
      .where(eq(telegramSessions.sessionId, sessionId));
  }
}

export const telegramManager = new TelegramManager();

telegramManager.initialize().catch(console.error);

const botController = new Elysia({ prefix: "/userbot" })
  .post(
    "/create-session",
    async ({ body }) => {
      const { sessionId, apiId, apiHash, phoneNumber, sessionString } = body;

      if (telegramManager.getService(sessionId)) {
        return { success: false, message: "Session already exists" };
      }

      try {
        const service = await telegramManager.createService(
          sessionId,
          apiId,
          apiHash,
          phoneNumber,
          sessionString,
        );

        return {
          success: true,
          message: "Session created and saved successfully",
          sessionId,
        };
      } catch (error) {
        return {
          success: false,
          message: "Failed to create session",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        apiId: t.Number(),
        apiHash: t.String(),
        phoneNumber: t.Optional(t.String()),
        sessionString: t.Optional(t.String()),
      }),
    },
  )
  .post("/:sessionId/start", async ({ params: { sessionId } }) => {
    const service = telegramManager.getService(sessionId);
    if (!service) {
      return { success: false, message: "Session not found" };
    }

    if (service.isClientStarted()) {
      return { success: true, message: "Already started" };
    }

    try {
      const sessionData = await db
        .select()
        .from(telegramSessions)
        .where(eq(telegramSessions.sessionId, sessionId))
        .limit(1);

      await service.start(async (type) => {
        if (type === "phoneNumber" && sessionData[0]?.phoneNumber) {
          return sessionData[0].phoneNumber;
        }

        telegramManager.setAuthState(sessionId, {
          awaitingAuth: true,
          authType: type,
        });

        return new Promise<string>((resolve, reject) => {
          telegramManager.setAuthState(sessionId, { resolve, reject });

          setTimeout(
            () => {
              telegramManager.setAuthState(sessionId, { awaitingAuth: false });
              reject(new Error("Auth timeout"));
            },
            5 * 60 * 1000,
          );
        });
      });
      const newSessionString = service.getSessionString();
      if (newSessionString) {
        await telegramManager.updateSessionString(sessionId, newSessionString);
      }

      return { success: true, message: "Started successfully" };
    } catch (error) {
      return {
        success: false,
        message: "Failed to start",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  })
  .post(
    "/:sessionId/auth",
    async ({ params: { sessionId }, body }) => {
      const authState = telegramManager.getAuthState(sessionId);
      if (!authState?.awaitingAuth || !authState.resolve) {
        return { success: false, message: "Not awaiting authentication" };
      }

      const { value } = body as { value: string };

      if (authState.authType === "phoneNumber") {
        await telegramManager.updatePhoneNumber(sessionId, value);
      }

      authState.resolve(value);
      telegramManager.setAuthState(sessionId, { awaitingAuth: false });

      return { success: true, message: "Auth data submitted" };
    },
    {
      body: t.Object({
        value: t.String(),
      }),
    },
  )

  // Get auth status
  .get("/:sessionId/auth-status", ({ params: { sessionId } }) => {
    const service = telegramManager.getService(sessionId);
    const authState = telegramManager.getAuthState(sessionId);

    if (!service) {
      return { exists: false };
    }

    return {
      exists: true,
      started: service.isClientStarted(),
      awaitingAuth: authState?.awaitingAuth || false,
      authType: authState?.authType,
    };
  })

  // Stop telegram client
  .post("/:sessionId/stop", async ({ params: { sessionId } }) => {
    const service = telegramManager.getService(sessionId);
    if (!service) {
      return { success: false, message: "Session not found" };
    }

    await service.stop();
    return { success: true, message: "Stopped successfully" };
  })
  .delete("/:sessionId", async ({ params: { sessionId } }) => {
    const service = telegramManager.getService(sessionId);
    if (!service) {
      return { success: false, message: "Session not found" };
    }

    await service.delete(sessionId);
    return { success: true, message: "Stopped successfully" };
  })

  // Get session string
  .get("/:sessionId/session-string", ({ params: { sessionId } }) => {
    const service = telegramManager.getService(sessionId);
    if (!service) {
      return { success: false, message: "Session not found" };
    }

    return {
      success: true,
      sessionString: service.getSessionString(),
    };
  })
  .get("/sessions", async () => {
    const sessions = await db.select().from(telegramSessions);
    return {
      success: true,
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        phoneNumber: session.phoneNumber,
        isActive: session.isActive,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
    };
  })
  .delete("/:sessionId", async ({ params: { sessionId } }) => {
    await telegramManager.removeService(sessionId);
    return { success: true, message: "Session removed" };
  })
  .get(
    "/messages",
    async ({ query }) => {
      const { channelId, limit = "50", offset = "0" } = query;

      const result = await db
        .select()
        .from(messages)
        .where(channelId ? eq(messages.channelId, channelId) : undefined)
        .limit(Number(limit))
        .offset(Number(offset))
        .orderBy(messages.date);

      return result;
    },
    {
      query: t.Object({
        channelId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )
  .get("/messages/:id", async ({ params: { id } }) => {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1);

    if (message.length === 0) {
      return { success: false, message: "Message not found" };
    }

    const media = await db
      .select()
      .from(messageMedia)
      .where(eq(messageMedia.messageId, id));

    return {
      success: true,
      data: {
        ...message[0],
        media,
      },
    };
  });

export default botController;
