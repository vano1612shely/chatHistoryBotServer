import {
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
  boolean,
  serial,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const user = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  login: text().notNull(),
  password: text().notNull(),
});

export const clients = pgTable("clients", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  username: text().unique(),
  name: text(),
  telegramId: text("telegram_id").unique().notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
  botId: text("bot_id").notNull(),
});

export const bots = pgTable("bots", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  token: text().notNull().unique(),
  username: text(),
  isActive: boolean("is_active").default(false),
  webhookUrl: text("webhook_url"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
  startMessage: text().notNull(),
  startMessageFile: text("start_message_file"),
});

export const telegramSessions = pgTable("telegram_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: varchar("session_id", { length: 255 }).notNull().unique(),
  apiId: integer("api_id").notNull(),
  apiHash: varchar("api_hash", { length: 255 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 50 }),
  sessionString: text("session_string"),
  isActive: boolean("is_active").default(false),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

export const messages = pgTable("messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  messageId: integer("message_id").notNull(),
  channelId: varchar("channel_id", { length: 255 }).notNull(),
  text: text("text"),
  date: timestamp("date", { mode: "date" }).notNull(),
});

export const messageMedia = pgTable("message_media", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  messageId: text("message_id").references(() => messages.id, {
    onDelete: "cascade",
  }),
  type: text("type").notNull(), // 'photo', 'video', 'audio', 'voice', 'document'
  fileId: text("file_id").notNull(),
  fileUniqueId: text("file_unique_id").notNull(),
  caption: text("caption").default(""),

  // Новые поля для локального хранения
  localFilePath: text("local_file_path"), // Путь к сохраненному файлу
  fileName: text("file_name"), // Имя файла на диске
  originalFileName: text("original_file_name"), // Оригинальное имя файла
  fileSize: integer("file_size"), // Размер файла в байтах
  mimeType: text("mime_type"), // MIME тип файла
  downloadedAt: timestamp("downloaded_at").defaultNow(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const allowedChannels = pgTable("allowed_channels", {
  id: serial("id").primaryKey(), // Внутрішній ID запису
  telegramChannelId: varchar("telegram_channel_id", { length: 255 })
    .notNull()
    .unique(), // ID каналу з Telegram (може бути великим числом або рядком типу -100xxxx)
  name: varchar("name", { length: 255 }), // Описова назва каналу (опціонально)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messagesRelations = relations(messages, ({ many }) => ({
  media: many(messageMedia),
}));

export const messageMediaRelations = relations(messageMedia, ({ one }) => ({
  message: one(messages, {
    fields: [messageMedia.messageId],
    references: [messages.id],
  }),
}));

export const telegramSessionsRelations = relations(
  telegramSessions,
  ({ many }) => ({
    messages: many(messages),
  }),
);

export const table = {
  user,
  clients,
  bots,
  telegramSessions,
  messages,
  messageMedia,
  allowedChannels,
} as const;
