import Elysia from "elysia";
import { jwt } from "@elysiajs/jwt";

export const authGuard = new Elysia()
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET!,
      exp: "7d",
    }),
  )
  .derive({ as: "scoped" }, async ({ headers, jwt, set, error }) => {
    if (!headers.token) {
      return error(401, "Authorization header missing");
    }

    try {
      const payload = await jwt.verify(headers.token);

      if (!payload) {
        return error(401, "Invalid token");
      }

      return {
        auth: payload,
      };
    } catch (err) {
      console.error("Token verification error:", err);
      return error(401, "Token verification failed");
    }
  });
