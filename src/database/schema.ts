import {
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
  boolean,
  serial,
  decimal,
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
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  channelId: varchar("channel_id").notNull(),
  messageId: integer("message_id").notNull(),
  text: text("text").default(""),
  date: timestamp("date").notNull(),
  groupedId: varchar("grouped_id"),
  isMediaGroup: boolean("is_media_group").default(false),
  parentMessageId: varchar("parent_message_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const messageMedia = pgTable("message_media", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  messageId: text("message_id").references(() => messages.id, {
    onDelete: "cascade",
  }),
  type: text("type").notNull(),
  fileId: text("file_id").notNull(),
  fileUniqueId: text("file_unique_id").notNull(),
  caption: text("caption").default(""),
  localFilePath: text("local_file_path"),
  fileName: text("file_name"),
  originalFileName: text("original_file_name"),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  downloadedAt: timestamp("downloaded_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const allowedChannels = pgTable("allowed_channels", {
  id: serial("id").primaryKey(),
  telegramChannelId: varchar("telegram_channel_id", { length: 255 })
    .notNull()
    .unique(),
  name: varchar("name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Новые таблицы для подписок
export const subscriptionPlans = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: integer("price").notNull(), // Цена в Telegram Stars
  durationDays: integer("duration_days").notNull(), // Длительность в днях
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userSubscriptions = pgTable("user_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => clients.id, {
      onDelete: "cascade",
    })
    .notNull(),
  subscriptionPlanId: integer("subscription_plan_id").references(
    () => subscriptionPlans.id,
    {
      onDelete: "cascade",
    },
  ), // Видалити .notNull() щоб дозволити null для ручних підписок
  startDate: timestamp("start_date").defaultNow().notNull(),
  endDate: timestamp("end_date").notNull(),
  isActive: boolean("is_active").default(true),
  isManual: boolean("is_manual").default(false), // Додаткове поле для позначення ручних підписок
  manualNote: text("manual_note"), // Поле для зберігання нотаток адміна
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const subscriptionTransactions = pgTable("subscription_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => clients.id, {
      onDelete: "cascade",
    })
    .notNull(),
  subscriptionPlanId: integer("subscription_plan_id")
    .references(() => subscriptionPlans.id, {
      onDelete: "cascade",
    })
    .notNull(),
  userSubscriptionId: integer("user_subscription_id").references(
    () => userSubscriptions.id,
    {
      onDelete: "cascade",
    },
  ),
  telegramPaymentChargeId: text("telegram_payment_charge_id").unique(),
  providerPaymentChargeId: text("provider_payment_charge_id"),
  amount: integer("amount").notNull(), // Сумма в Telegram Stars
  currency: varchar("currency", { length: 10 }).default("XTR"), // XTR для Telegram Stars
  status: varchar("status", { length: 50 }).default("pending"), // pending, completed, failed, refunded
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
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

export const clientsRelations = relations(clients, ({ many }) => ({
  subscriptions: many(userSubscriptions),
  transactions: many(subscriptionTransactions),
}));

export const subscriptionPlansRelations = relations(
  subscriptionPlans,
  ({ many }) => ({
    userSubscriptions: many(userSubscriptions),
    transactions: many(subscriptionTransactions),
  }),
);

export const userSubscriptionsRelations = relations(
  userSubscriptions,
  ({ one, many }) => ({
    user: one(clients, {
      fields: [userSubscriptions.userId],
      references: [clients.id],
    }),
    subscriptionPlan: one(subscriptionPlans, {
      fields: [userSubscriptions.subscriptionPlanId],
      references: [subscriptionPlans.id],
    }),
    transactions: many(subscriptionTransactions),
  }),
);

export const subscriptionTransactionsRelations = relations(
  subscriptionTransactions,
  ({ one }) => ({
    user: one(clients, {
      fields: [subscriptionTransactions.userId],
      references: [clients.id],
    }),
    subscriptionPlan: one(subscriptionPlans, {
      fields: [subscriptionTransactions.subscriptionPlanId],
      references: [subscriptionPlans.id],
    }),
    userSubscription: one(userSubscriptions, {
      fields: [subscriptionTransactions.userSubscriptionId],
      references: [userSubscriptions.id],
    }),
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
  subscriptionPlans,
  userSubscriptions,
  subscriptionTransactions,
} as const;
