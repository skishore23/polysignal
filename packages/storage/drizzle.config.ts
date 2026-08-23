import type { Config } from "drizzle-kit";

export default {
    schema: "./src/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
    dbCredentials: {
        url: "file:../../data/dev.db",
    },
} satisfies Config;
