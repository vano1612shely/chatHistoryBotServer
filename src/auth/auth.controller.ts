import Elysia, { t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { AuthService } from "./auth.service";
import { authGuard } from "./auth.guard";

const authService = new AuthService();

export const auth = new Elysia({ prefix: "/auth" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET!,
      exp: "7d",
    }),
  )
  .post(
    "/create",
    async ({ body, set }) => {
      try {
        const newUser = await authService.createUser(body);

        return {
          message: "User created successfully",
          user: newUser,
        };
      } catch (error) {
        console.error("Error creating user:", error);

        if (error instanceof Error) {
          switch (error.message) {
            case "USER_ALREADY_EXISTS":
              set.status = 409;
              return { error: "User already exists" };
            default:
              set.status = 500;
              return { error: "Internal server error" };
          }
        }

        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      body: t.Object({
        login: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
      }),
    },
  )
  .post(
    "/login",
    async ({ body, jwt, set }) => {
      try {
        const user = await authService.loginUser(body);

        // Створюємо JWT токен
        const token = await jwt.sign({
          userId: user.id,
          login: user.login,
          role: "user",
        });

        return {
          message: "Login successful",
          token,
          user,
        };
      } catch (error) {
        console.error("Error during login:", error);

        if (error instanceof Error) {
          switch (error.message) {
            case "INVALID_CREDENTIALS":
              set.status = 401;
              return { error: "Invalid credentials" };
            default:
              set.status = 500;
              return { error: "Internal server error" };
          }
        }

        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    {
      body: t.Object({
        login: t.String(),
        password: t.String(),
      }),
    },
  );

export const protectedAuth = new Elysia({ prefix: "/auth" })
  .use(authGuard)
  .get("/me", async ({ auth }) => {
    return {
      user: {
        userId: auth.userId,
        login: auth.login,
        role: auth.role,
      },
    };
  });
