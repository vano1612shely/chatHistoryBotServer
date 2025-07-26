import { Elysia, t } from "elysia";
import { ClientService } from "./client-service";
import { SubscriptionService } from "../subcription/subscription-service";

const clientService = new ClientService();
const subscriptionService = new SubscriptionService();

export const clientController = new Elysia({ prefix: "/client" })
  .decorate("userService", clientService)
  .decorate("subscriptionService", subscriptionService)
  .get("/", async () => {
    try {
      const users = await clientService.getAllUsers();
      return {
        success: true,
        data: users,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Помилка отримання користувачів",
      };
    }
  })
  .get(
    "/telegram/:telegramId",
    async ({ params, set }) => {
      try {
        const user = await clientService.findUserByTelegramId(
          params.telegramId,
        );
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          data: user,
        };
      } catch (error) {
        set.status = 500;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка пошуку користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
    },
  )
  .put(
    "/telegram/:telegramId",
    async ({ params, body, set }) => {
      try {
        const user = await clientService.updateUser(params.telegramId, body);
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          message: "Користувач успішно оновлений",
          data: user,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка оновлення користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
      body: t.Object({
        username: t.Optional(t.String()),
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
      }),
    },
  )

  // Видалення користувача
  .delete(
    "/telegram/:telegramId",
    async ({ params, set }) => {
      try {
        const user = await clientService.deleteUser(params.telegramId);
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }
        return {
          success: true,
          message: "Користувач успішно видалений",
          data: user,
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка видалення користувача",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
    },
  )

  // НОВИЙ ЕНДПОІНТ: Ручна видача підписки користувачу
  .post(
    "/telegram/:telegramId/grant-subscription",
    async ({ params, body, set }) => {
      try {
        const result = await subscriptionService.grantManualSubscription({
          telegramId: params.telegramId,
          durationDays: body.durationDays,
          note: body.note,
        });

        return {
          success: true,
          message: result.message,
          data: {
            subscription: result.subscription,
            user: result.user,
          },
        };
      } catch (error) {
        set.status = 400;
        return {
          success: false,
          message:
            error instanceof Error ? error.message : "Помилка видачі підписки",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
      body: t.Object({
        durationDays: t.Number({ minimum: 1, maximum: 3650 }), // від 1 дня до 10 років
        note: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  )

  // Отримання активної підписки користувача
  .get(
    "/telegram/:telegramId/subscription",
    async ({ params, set }) => {
      try {
        const user = await clientService.findUserByTelegramId(
          params.telegramId,
        );
        if (!user) {
          set.status = 404;
          return {
            success: false,
            message: "Користувач не знайдений",
          };
        }

        const subscription =
          await subscriptionService.getUserActiveSubscription(user.id);

        return {
          success: true,
          data: {
            hasActiveSubscription: !!subscription,
            subscription: subscription,
          },
        };
      } catch (error) {
        set.status = 500;
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Помилка отримання підписки",
        };
      }
    },
    {
      params: t.Object({
        telegramId: t.String(),
      }),
    },
  );
