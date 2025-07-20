import { Elysia, t } from "elysia";
import { SubscriptionService } from "./subscription-service";

export const subscriptionController = new Elysia({
  prefix: "/api/subscriptions",
})
  .decorate("subscriptionService", new SubscriptionService())

  // Создание плана подписки
  .post(
    "/plans",
    async ({ body, subscriptionService }) => {
      try {
        const plan = await subscriptionService.createSubscriptionPlan(body);
        return { success: true, data: plan };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        price: t.Number({ minimum: 1 }),
        durationDays: t.Number({ minimum: 1 }),
      }),
    },
  )

  // Получение всех планов подписки
  .get("/plans", async ({ subscriptionService }) => {
    try {
      const plans = await subscriptionService.getAllSubscriptionPlans();
      return { success: true, data: plans };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  })

  // Получение плана подписки по ID
  .get(
    "/plans/:id",
    async ({ params, subscriptionService }) => {
      try {
        const plan = await subscriptionService.getSubscriptionPlanById(
          parseInt(params.id),
        );
        if (!plan) {
          return { success: false, error: "План подписки не найден" };
        }
        return { success: true, data: plan };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  // Обновление плана подписки
  .put(
    "/plans/:id",
    async ({ params, body, subscriptionService }) => {
      try {
        const plan = await subscriptionService.updateSubscriptionPlan(
          parseInt(params.id),
          body,
        );
        return { success: true, data: plan };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        price: t.Optional(t.Number({ minimum: 1 })),
        durationDays: t.Optional(t.Number({ minimum: 1 })),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )

  // Удаление плана подписки
  .delete(
    "/plans/:id",
    async ({ params, subscriptionService }) => {
      try {
        const plan = await subscriptionService.deleteSubscriptionPlan(
          parseInt(params.id),
        );
        return { success: true, data: plan };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  // Получение активной подписки пользователя
  .get(
    "/user/:userId/active",
    async ({ params, subscriptionService }) => {
      try {
        const subscription =
          await subscriptionService.getUserActiveSubscription(
            parseInt(params.userId),
          );
        return { success: true, data: subscription };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        userId: t.String(),
      }),
    },
  )

  // Получение транзакций пользователя
  .get(
    "/user/:userId/transactions",
    async ({ params, subscriptionService }) => {
      try {
        const transactions = await subscriptionService.getUserTransactions(
          parseInt(params.userId),
        );
        return { success: true, data: transactions };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        userId: t.String(),
      }),
    },
  )

  // Получение всех транзакций (для админки)
  .get(
    "/transactions",
    async ({ query, subscriptionService }) => {
      try {
        const limit = parseInt(query.limit || "100");
        const offset = parseInt(query.offset || "0");
        const transactions = await subscriptionService.getAllTransactions(
          limit,
          offset,
        );
        return { success: true, data: transactions };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    },
  )

  // Обновление статуса транзакции
  .patch(
    "/transactions/:id/status",
    async ({ params, body, subscriptionService }) => {
      try {
        const transaction = await subscriptionService.updateTransactionStatus(
          parseInt(params.id),
          body.status,
        );
        return { success: true, data: transaction };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        status: t.String(),
      }),
    },
  )

  // Деактивация истекших подписок
  .post("/cleanup-expired", async ({ subscriptionService }) => {
    try {
      const expiredSubscriptions =
        await subscriptionService.deactivateExpiredSubscriptions();
      return {
        success: true,
        message: `Деактивировано ${expiredSubscriptions.length} истекших подписок`,
        data: expiredSubscriptions,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
